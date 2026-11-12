//! # InvoiceManager
//!
//! On-chain invoices with a strict lifecycle and settlement through
//! `PaymentRouter`, so an invoice payment is a real routed payment (fee split,
//! treasury leg, merchant settlement leg) rather than a bookkeeping flag.
//!
//! ```text
//! create -> Open --pay--> Paid
//!              \--cancel--> Cancelled
//!              \--due date passed + mark_expired--> Expired
//! ```
//!
//! Security assumptions:
//! * Only the merchant owner recorded in `MerchantRegistry` may create or
//!   cancel an invoice for that merchant, and only an `Active` merchant may
//!   invoice.
//! * `pay` requires the payer's authorization; the nested payment router call is
//!   covered by the same authorization entry.
//! * Expiry is derived from ledger time, never from a caller-supplied timestamp.
//! * `Paid`, `Cancelled` and `Expired` are terminal; no path reopens an invoice.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String};
use wpay_common::{
    access, pause, validation, Error, Merchant, MerchantStatus, RegistryClient, Role, RouterClient,
};

pub const MAX_MEMO_LEN: u32 = 64;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvoiceStatus {
    Open,
    Paid,
    Cancelled,
    Expired,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Invoice {
    pub id: u64,
    pub merchant_id: u64,
    pub merchant: Address,
    pub token: Address,
    pub amount: i128,
    pub memo: String,
    pub due_at: u64,
    pub created_at: u64,
    pub paid_at: Option<u64>,
    pub payment_id: Option<u64>,
    pub status: InvoiceStatus,
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Invoice(u64),
    NextId,
    Count,
    OpenCount,
    Router,
    Registry,
}

#[contract]
pub struct InvoiceManager;

#[contractimpl]
impl InvoiceManager {
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

    /// Creates an invoice for an active merchant. Returns the invoice id.
    pub fn create(
        env: Env,
        owner: Address,
        merchant_id: u64,
        token: Address,
        amount: i128,
        due_at: u64,
        memo: String,
    ) -> Result<u64, Error> {
        pause::require_not_paused(&env)?;
        owner.require_auth();
        validation::require_positive(amount)?;
        validation::require_future(&env, due_at)?;
        if memo.len() > MAX_MEMO_LEN {
            return Err(Error::InvalidInput);
        }

        let registry = Self::registry(env.clone())?;
        let merchant: Merchant = RegistryClient::new(&env, &registry).get(&merchant_id);
        if merchant.owner != owner {
            return Err(Error::Unauthorized);
        }
        if merchant.status != MerchantStatus::Active {
            return Err(Error::InvalidState);
        }

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        let invoice = Invoice {
            id,
            merchant_id,
            merchant: owner.clone(),
            token,
            amount,
            memo,
            due_at,
            created_at: env.ledger().timestamp(),
            paid_at: None,
            payment_id: None,
            status: InvoiceStatus::Open,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Invoice(id), &invoice);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        let count: u64 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        env.storage().instance().set(&DataKey::Count, &(count + 1));
        let open: u64 = env
            .storage()
            .instance()
            .get(&DataKey::OpenCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::OpenCount, &(open + 1));

        env.events()
            .publish((symbol_short!("invoice"), id), (owner, merchant_id, amount));
        Ok(id)
    }

    /// Pays an open invoice through the payment router. Returns the payment id.
    pub fn pay(env: Env, payer: Address, invoice_id: u64) -> Result<u64, Error> {
        pause::require_not_paused(&env)?;
        payer.require_auth();
        let mut invoice = Self::get(env.clone(), invoice_id)?;
        if invoice.status != InvoiceStatus::Open {
            return Err(Error::InvalidState);
        }
        if env.ledger().timestamp() > invoice.due_at {
            return Err(Error::Expired);
        }

        let router = Self::router(env.clone())?;
        let payment_id = RouterClient::new(&env, &router).create_payment(
            &payer,
            &invoice.merchant_id,
            &invoice.token,
            &invoice.amount,
            &invoice.memo,
        );

        invoice.status = InvoiceStatus::Paid;
        invoice.paid_at = Some(env.ledger().timestamp());
        invoice.payment_id = Some(payment_id);
        env.storage()
            .persistent()
            .set(&DataKey::Invoice(invoice_id), &invoice);
        let open: u64 = env
            .storage()
            .instance()
            .get(&DataKey::OpenCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::OpenCount, &open.saturating_sub(1));

        env.events()
            .publish((symbol_short!("paid"), invoice_id), (payer, payment_id));
        Ok(payment_id)
    }

    /// Merchant-owner cancellation. Only an open invoice can be cancelled.
    pub fn cancel(env: Env, owner: Address, invoice_id: u64) -> Result<(), Error> {
        owner.require_auth();
        let mut invoice = Self::get(env.clone(), invoice_id)?;
        if invoice.merchant != owner {
            return Err(Error::Unauthorized);
        }
        if invoice.status != InvoiceStatus::Open {
            return Err(Error::InvalidState);
        }
        invoice.status = InvoiceStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Invoice(invoice_id), &invoice);
        let open: u64 = env
            .storage()
            .instance()
            .get(&DataKey::OpenCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::OpenCount, &open.saturating_sub(1));
        env.events()
            .publish((symbol_short!("cancel"), invoice_id), owner);
        Ok(())
    }

    /// Marks an overdue invoice expired. Callable by anyone: the transition only
    /// depends on ledger time, so there is nothing to authorize.
    pub fn mark_expired(env: Env, invoice_id: u64) -> Result<(), Error> {
        let mut invoice = Self::get(env.clone(), invoice_id)?;
        if invoice.status != InvoiceStatus::Open {
            return Err(Error::InvalidState);
        }
        if env.ledger().timestamp() <= invoice.due_at {
            return Err(Error::InvalidState);
        }
        invoice.status = InvoiceStatus::Expired;
        env.storage()
            .persistent()
            .set(&DataKey::Invoice(invoice_id), &invoice);
        let open: u64 = env
            .storage()
            .instance()
            .get(&DataKey::OpenCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::OpenCount, &open.saturating_sub(1));
        env.events()
            .publish((symbol_short!("expire"), invoice_id), invoice.due_at);
        Ok(())
    }

    pub fn get(env: Env, id: u64) -> Result<Invoice, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Invoice(id))
            .ok_or(Error::NotFound)
    }

    pub fn count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    pub fn open_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::OpenCount)
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

    pub fn set_registry(env: Env, caller: Address, registry: Address) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        env.storage().instance().set(&DataKey::Registry, &registry);
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
