//! # RefundManager
//!
//! Two-party refund workflow with real fund movement.
//!
//! A payer requests a refund against a routed payment; the merchant owner
//! approves or rejects it. Approval moves the money from the merchant's current
//! settlement address back to the payer and records the refund in
//! `PaymentRouter`, which keeps cumulative refunds bounded by the original
//! payment amount.
//!
//! Security assumptions:
//! * Only the payer on the original payment may request a refund, and only up to
//!   the unrefunded remainder.
//! * Approval and rejection are authorized by the merchant's **settlement
//!   address**, not the registry owner: that is the wallet holding the money, and
//!   a token transfer out of it needs its own signature. A merchant whose
//!   settlement wallet differs from the owner account signs the decision with the
//!   settlement key.
//! * `RefundManager` must hold the `Operator` role on `PaymentRouter`; that role
//!   is what allows it to record refunds.
//! * Approval re-reads the merchant's settlement address at approval time, so a
//!   rotated address cannot send funds to a stale destination.
//! * The router call happens after the token transfer; if either fails the whole
//!   transaction reverts, so the ledger and the router can never disagree.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String};
use wpay_common::{
    access, tokens, validation, Error, Merchant, Payment, RegistryClient, Role, RouterClient,
};

pub const MAX_REASON_LEN: u32 = 128;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RefundStatus {
    Pending,
    Approved,
    Rejected,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Refund {
    pub id: u64,
    pub payment_id: u64,
    pub merchant_id: u64,
    pub payer: Address,
    pub amount: i128,
    pub reason: String,
    pub status: RefundStatus,
    pub created_at: u64,
    pub decided_at: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Refund(u64),
    NextId,
    Count,
    PendingCount,
    Router,
    Registry,
}

#[contract]
pub struct RefundManager;

#[contractimpl]
impl RefundManager {
    pub fn initialize(
        env: Env,
        admin: Address,
        router: Address,
        registry: Address,
    ) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Router, &router);
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        Ok(())
    }

    /// Opens a refund request. The caller must authorize as the payment payer.
    pub fn request(
        env: Env,
        payer: Address,
        payment_id: u64,
        amount: i128,
        reason: String,
    ) -> Result<u64, Error> {
        payer.require_auth();
        validation::require_positive(amount)?;
        if reason.len() > MAX_REASON_LEN {
            return Err(Error::InvalidInput);
        }

        let router = Self::router(env.clone())?;
        let payment: Payment = RouterClient::new(&env, &router).get_payment(&payment_id);
        if payment.payer != payer {
            return Err(Error::Unauthorized);
        }
        if amount > payment.amount - payment.refunded {
            return Err(Error::LimitExceeded);
        }

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        let refund = Refund {
            id,
            payment_id,
            merchant_id: payment.merchant_id,
            payer,
            amount,
            reason,
            status: RefundStatus::Pending,
            created_at: env.ledger().timestamp(),
            decided_at: None,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Refund(id), &refund);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        let count: u64 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        env.storage().instance().set(&DataKey::Count, &(count + 1));
        let pending: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PendingCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::PendingCount, &(pending + 1));

        env.events()
            .publish((symbol_short!("request"), id), (payment_id, amount));
        Ok(id)
    }

    /// Merchant approval: pays the payer and records the refund on the router.
    /// `settlement` must be the merchant's current settlement address.
    pub fn approve(env: Env, settlement: Address, refund_id: u64) -> Result<(), Error> {
        settlement.require_auth();
        let mut refund = Self::get(env.clone(), refund_id)?;
        if refund.status != RefundStatus::Pending {
            return Err(Error::InvalidState);
        }

        let registry = Self::registry(env.clone())?;
        let merchant: Merchant = RegistryClient::new(&env, &registry).get(&refund.merchant_id);
        if merchant.settlement != settlement {
            return Err(Error::Unauthorized);
        }

        let router = Self::router(env.clone())?;
        let payment: Payment = RouterClient::new(&env, &router).get_payment(&refund.payment_id);
        if refund.amount > payment.amount - payment.refunded {
            // The payment was partially refunded elsewhere in the meantime.
            return Err(Error::LimitExceeded);
        }

        tokens::transfer(
            &env,
            &payment.token,
            &merchant.settlement,
            &refund.payer,
            refund.amount,
        );
        RouterClient::new(&env, &router).record_refund(
            &env.current_contract_address(),
            &refund.payment_id,
            &refund.amount,
        );

        refund.status = RefundStatus::Approved;
        refund.decided_at = Some(env.ledger().timestamp());
        env.storage()
            .persistent()
            .set(&DataKey::Refund(refund_id), &refund);
        Self::decrement_pending(&env);

        env.events().publish(
            (symbol_short!("approve"), refund_id),
            (settlement, refund.amount),
        );
        Ok(())
    }

    /// Merchant rejection. No funds move. Authorized by the settlement address.
    pub fn reject(
        env: Env,
        settlement: Address,
        refund_id: u64,
        reason: String,
    ) -> Result<(), Error> {
        settlement.require_auth();
        if reason.len() > MAX_REASON_LEN {
            return Err(Error::InvalidInput);
        }
        let mut refund = Self::get(env.clone(), refund_id)?;
        if refund.status != RefundStatus::Pending {
            return Err(Error::InvalidState);
        }
        let registry = Self::registry(env.clone())?;
        let merchant: Merchant = RegistryClient::new(&env, &registry).get(&refund.merchant_id);
        if merchant.settlement != settlement {
            return Err(Error::Unauthorized);
        }
        refund.status = RefundStatus::Rejected;
        refund.decided_at = Some(env.ledger().timestamp());
        env.storage()
            .persistent()
            .set(&DataKey::Refund(refund_id), &refund);
        Self::decrement_pending(&env);
        env.events()
            .publish((symbol_short!("reject"), refund_id), settlement);
        Ok(())
    }

    pub fn get(env: Env, id: u64) -> Result<Refund, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Refund(id))
            .ok_or(Error::NotFound)
    }

    pub fn count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    pub fn pending_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::PendingCount)
            .unwrap_or(0)
    }

    pub fn router(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Router)
            .ok_or(Error::NotInitialized)
    }

    pub fn registry(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(Error::NotInitialized)
    }

    pub fn set_router(env: Env, caller: Address, router: Address) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        env.storage().instance().set(&DataKey::Router, &router);
        Ok(())
    }

    pub fn grant_role(
        env: Env,
        caller: Address,
        role: Role,
        account: Address,
    ) -> Result<(), Error> {
        access::grant(&env, &caller, role, &account)
    }

    pub fn has_role(env: Env, role: Role, account: Address) -> bool {
        access::has_role(&env, role, &account)
    }
}

impl RefundManager {
    fn decrement_pending(env: &Env) {
        let pending: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PendingCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::PendingCount, &pending.saturating_sub(1));
    }
}

#[cfg(test)]
mod test;
