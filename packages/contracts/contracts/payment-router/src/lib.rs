//! # PaymentRouter
//!
//! The core money path: a payer transfers value for a merchant, the platform fee
//! is routed to the treasury and the remainder to the merchant's settlement
//! address in the same transaction.
//!
//! Payment state machine:
//!
//! ```text
//! create --> Settled --refund(partial)--> PartiallyRefunded --refund--> Refunded
//!                  \--refund(full)-----------------------------------> Refunded
//! ```
//!
//! Security assumptions:
//! * The payer authorizes the payment, which also covers both token transfers
//!   made in the same invocation tree.
//! * Merchant identity, status and settlement address come from
//!   `MerchantRegistry`; a caller cannot redirect funds to an arbitrary address.
//! * The fee split comes from `FeeManager`, so fee policy has exactly one
//!   source of truth. Both dependencies are set once by an admin.
//! * Refunds are recorded by an `Operator` (in practice the `RefundManager`
//!   contract). The router tracks cumulative refunds and never records more
//!   than the original amount; the token movement itself happens in
//!   `RefundManager`, which is the funds-holding component for refunds.
//! * The router holds no balance between transactions, so it has no treasury
//!   risk of its own.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String};
use wpay_common::{
    access, pause, tokens, validation, Error, FeeManagerClient, FeeSplit, Merchant, MerchantStatus,
    RegistryClient, Role,
};

pub use wpay_common::{Payment, PaymentStatus};

pub const MAX_MEMO_LEN: u32 = 64;

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Payment(u64),
    NextPaymentId,
    Registry,
    FeeManager,
    Treasury,
    Volume(u64),
}

#[contract]
pub struct PaymentRouter;

#[contractimpl]
impl PaymentRouter {
    pub fn initialize(
        env: Env,
        admin: Address,
        registry: Address,
        fee_manager: Address,
        treasury: Address,
    ) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage()
            .instance()
            .set(&DataKey::FeeManager, &fee_manager);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::NextPaymentId, &1u64);
        env.events()
            .publish((symbol_short!("init"),), (admin, registry, fee_manager));
        Ok(())
    }

    /// Creates a payment and moves the funds in the same transaction.
    ///
    /// The merchant must be `Active` in the registry. The fee is computed by the
    /// fee manager for the merchant owner, so the payer cannot influence it.
    pub fn create_payment(
        env: Env,
        payer: Address,
        merchant_id: u64,
        token: Address,
        amount: i128,
        memo: String,
    ) -> Result<u64, Error> {
        pause::require_not_paused(&env)?;
        payer.require_auth();
        validation::require_positive(amount)?;
        if memo.len() > MAX_MEMO_LEN {
            return Err(Error::InvalidInput);
        }

        let registry = Self::registry(env.clone())?;
        let merchant: Merchant = RegistryClient::new(&env, &registry).get(&merchant_id);
        if merchant.status != MerchantStatus::Active {
            return Err(Error::InvalidState);
        }

        let fee_manager = Self::fee_manager(env.clone())?;
        let FeeSplit { fee, net } =
            FeeManagerClient::new(&env, &fee_manager).calculate(&merchant.owner, &amount);
        if fee < 0 || net < 0 || fee + net != amount {
            return Err(Error::InvalidInput);
        }

        let treasury = Self::treasury(env.clone())?;
        // Two legs, one authorization: the payer approved this invocation tree.
        tokens::transfer(&env, &token, &payer, &treasury, fee);
        tokens::transfer(&env, &token, &payer, &merchant.settlement, net);

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextPaymentId)
            .unwrap_or(1);
        let payment = Payment {
            id,
            merchant_id,
            payer: payer.clone(),
            token: token.clone(),
            amount,
            fee,
            net,
            refunded: 0,
            memo,
            created_at: env.ledger().timestamp(),
            status: PaymentStatus::Settled,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Payment(id), &payment);
        env.storage()
            .instance()
            .set(&DataKey::NextPaymentId, &(id + 1));

        let volume: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Volume(merchant_id))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::Volume(merchant_id), &(volume + amount));

        env.events().publish(
            (symbol_short!("payment"), id),
            (payer, merchant_id, amount, fee),
        );
        Ok(id)
    }

    /// Records a refund against a payment. Operator only (the `RefundManager`
    /// contract holds that role in production). Returns the new refunded total.
    pub fn record_refund(
        env: Env,
        caller: Address,
        payment_id: u64,
        amount: i128,
    ) -> Result<i128, Error> {
        caller.require_auth();
        access::require_role(&env, Role::Operator, &caller)?;
        validation::require_positive(amount)?;

        let mut payment = Self::get_payment(env.clone(), payment_id)?;
        let refundable = payment.amount - payment.refunded;
        if amount > refundable {
            return Err(Error::LimitExceeded);
        }
        payment.refunded += amount;
        payment.status = if payment.refunded == payment.amount {
            PaymentStatus::Refunded
        } else {
            PaymentStatus::PartiallyRefunded
        };
        env.storage()
            .persistent()
            .set(&DataKey::Payment(payment_id), &payment);

        env.events().publish(
            (symbol_short!("refund"), payment_id),
            (caller, amount, payment.refunded),
        );
        Ok(payment.refunded)
    }

    pub fn get_payment(env: Env, id: u64) -> Result<Payment, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Payment(id))
            .ok_or(Error::NotFound)
    }

    /// Total amount ever processed for a merchant, in that merchant's token.
    pub fn volume(env: Env, merchant_id: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Volume(merchant_id))
            .unwrap_or(0)
    }

    pub fn next_payment_id(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::NextPaymentId)
            .unwrap_or(1)
    }

    pub fn registry(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Registry)
            .ok_or(Error::NotInitialized)
    }

    pub fn fee_manager(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::FeeManager)
            .ok_or(Error::NotInitialized)
    }

    pub fn treasury(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(Error::NotInitialized)
    }

    pub fn set_treasury(env: Env, caller: Address, treasury: Address) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.events()
            .publish((symbol_short!("treasury"),), (caller, treasury));
        Ok(())
    }

    pub fn set_registry(env: Env, caller: Address, registry: Address) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        env.storage().instance().set(&DataKey::Registry, &registry);
        Ok(())
    }

    pub fn set_fee_manager(env: Env, caller: Address, fee_manager: Address) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        env.storage()
            .instance()
            .set(&DataKey::FeeManager, &fee_manager);
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

    pub fn set_pause_authority(env: Env, caller: Address, authority: Address) -> Result<(), Error> {
        pause::set_authority(&env, &caller, &authority)
    }

    pub fn set_paused(env: Env, caller: Address, paused: bool) -> Result<(), Error> {
        pause::set_paused(&env, &caller, paused)
    }

    pub fn is_paused(env: Env) -> bool {
        pause::is_paused(&env)
    }
}

#[cfg(test)]
mod test;
