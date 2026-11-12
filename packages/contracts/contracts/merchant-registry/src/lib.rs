//! # MerchantRegistry
//!
//! On-chain merchant records: one merchant per owner address, an explicit
//! approval lifecycle, and the settlement address revenue is routed to.
//!
//! State machine:
//!
//! ```text
//! register -> Pending --approve--> Active <--reactivate-- Suspended
//!                                   |                      ^
//!                                   +------suspend---------+
//!                                   |
//!                               close --> Closed (terminal)
//! ```
//!
//! Security assumptions:
//! * Registration is self-service and requires the owner's authorization, so an
//!   address can only register itself.
//! * Approval, suspension and reactivation require local `Operator`; closing
//!   requires the merchant owner.
//! * A closed merchant is terminal — it cannot be reopened, which keeps the
//!   settlement history of an offboarded merchant unambiguous.
//! * `settlement` is a plain address, not validated against a Stellar account
//!   existance check; the API verifies the account before submitting.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String};
use wpay_common::{access, validation, Error, Role};

pub use wpay_common::{Merchant, MerchantStatus};

pub const MAX_NAME_LEN: u32 = 64;
pub const MAX_FEE_BPS: u32 = 1_000;

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Merchant(u64),
    Owner(Address),
    NextId,
    Count,
    ActiveCount,
}

#[contract]
pub struct MerchantRegistry;

#[contractimpl]
impl MerchantRegistry {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::NextId, &1u64);
        Ok(())
    }

    /// Self-service registration. Returns the new merchant id.
    pub fn register(
        env: Env,
        owner: Address,
        settlement: Address,
        name: String,
        fee_bps: u32,
    ) -> Result<u64, Error> {
        access::require_initialized(&env)?;
        owner.require_auth();
        wpay_common::pause::require_not_paused(&env)?;
        validation::require_bps(fee_bps, MAX_FEE_BPS)?;
        if name.len() == 0 || name.len() > MAX_NAME_LEN {
            return Err(Error::InvalidInput);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::Owner(owner.clone()))
        {
            return Err(Error::AlreadyExists);
        }

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        let merchant = Merchant {
            id,
            owner: owner.clone(),
            settlement,
            name,
            fee_bps,
            status: MerchantStatus::Pending,
            created_at: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Merchant(id), &merchant);
        env.storage()
            .persistent()
            .set(&DataKey::Owner(owner.clone()), &id);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        let count: u64 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        env.storage().instance().set(&DataKey::Count, &(count + 1));

        env.events()
            .publish((symbol_short!("register"),), (id, owner));
        Ok(id)
    }

    /// Pending -> Active. Operator only.
    pub fn approve(env: Env, caller: Address, id: u64) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Operator, &caller)?;
        let mut merchant = Self::get(env.clone(), id)?;
        if merchant.status != MerchantStatus::Pending {
            return Err(Error::InvalidState);
        }
        merchant.status = MerchantStatus::Active;
        env.storage()
            .persistent()
            .set(&DataKey::Merchant(id), &merchant);
        let active: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ActiveCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::ActiveCount, &(active + 1));
        env.events().publish((symbol_short!("approve"), id), caller);
        Ok(())
    }

    /// Active -> Suspended. Operator only. Suspended merchants must not be
    /// allowed to create new payments by the consuming contracts.
    pub fn suspend(env: Env, caller: Address, id: u64) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Operator, &caller)?;
        let mut merchant = Self::get(env.clone(), id)?;
        if merchant.status != MerchantStatus::Active {
            return Err(Error::InvalidState);
        }
        merchant.status = MerchantStatus::Suspended;
        env.storage()
            .persistent()
            .set(&DataKey::Merchant(id), &merchant);
        let active: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ActiveCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::ActiveCount, &active.saturating_sub(1));
        env.events().publish((symbol_short!("suspend"), id), caller);
        Ok(())
    }

    /// Suspended -> Active. Operator only.
    pub fn reactivate(env: Env, caller: Address, id: u64) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Operator, &caller)?;
        let mut merchant = Self::get(env.clone(), id)?;
        if merchant.status != MerchantStatus::Suspended {
            return Err(Error::InvalidState);
        }
        merchant.status = MerchantStatus::Active;
        env.storage()
            .persistent()
            .set(&DataKey::Merchant(id), &merchant);
        let active: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ActiveCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::ActiveCount, &(active + 1));
        Ok(())
    }

    /// Terminal offboarding by the owner.
    pub fn close(env: Env, owner: Address, id: u64) -> Result<(), Error> {
        let mut merchant = Self::get(env.clone(), id)?;
        if merchant.owner != owner {
            return Err(Error::Unauthorized);
        }
        owner.require_auth();
        if merchant.status == MerchantStatus::Closed {
            return Err(Error::InvalidState);
        }
        let was_active = merchant.status == MerchantStatus::Active;
        merchant.status = MerchantStatus::Closed;
        env.storage()
            .persistent()
            .set(&DataKey::Merchant(id), &merchant);
        if was_active {
            let active: u64 = env
                .storage()
                .instance()
                .get(&DataKey::ActiveCount)
                .unwrap_or(0);
            env.storage()
                .instance()
                .set(&DataKey::ActiveCount, &active.saturating_sub(1));
        }
        env.events().publish((symbol_short!("close"), id), owner);
        Ok(())
    }

    /// Owner-only settlement address rotation.
    pub fn update_settlement(
        env: Env,
        owner: Address,
        id: u64,
        settlement: Address,
    ) -> Result<(), Error> {
        let mut merchant = Self::get(env.clone(), id)?;
        if merchant.owner != owner {
            return Err(Error::Unauthorized);
        }
        owner.require_auth();
        if merchant.status == MerchantStatus::Closed {
            return Err(Error::InvalidState);
        }
        merchant.settlement = settlement.clone();
        env.storage()
            .persistent()
            .set(&DataKey::Merchant(id), &merchant);
        env.events()
            .publish((symbol_short!("settle"), id), settlement);
        Ok(())
    }

    pub fn set_fee_bps(env: Env, caller: Address, id: u64, fee_bps: u32) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        validation::require_bps(fee_bps, MAX_FEE_BPS)?;
        let mut merchant = Self::get(env.clone(), id)?;
        merchant.fee_bps = fee_bps;
        env.storage()
            .persistent()
            .set(&DataKey::Merchant(id), &merchant);
        Ok(())
    }

    pub fn get(env: Env, id: u64) -> Result<Merchant, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Merchant(id))
            .ok_or(Error::NotFound)
    }

    pub fn merchant_of(env: Env, owner: Address) -> Option<u64> {
        env.storage().persistent().get(&DataKey::Owner(owner))
    }

    pub fn is_active(env: Env, id: u64) -> bool {
        matches!(Self::get(env, id), Ok(m) if m.status == MerchantStatus::Active)
    }

    pub fn count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    pub fn active_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ActiveCount)
            .unwrap_or(0)
    }

    pub fn grant_role(
        env: Env,
        caller: Address,
        role: Role,
        account: Address,
    ) -> Result<(), Error> {
        access::grant(&env, &caller, role, &account)
    }

    /// Sets the address allowed to pause this contract, normally the
    /// `EmergencyPause` contract. Admin only.
    pub fn set_pause_authority(env: Env, caller: Address, authority: Address) -> Result<(), Error> {
        wpay_common::pause::set_authority(&env, &caller, &authority)
    }

    pub fn set_paused(env: Env, caller: Address, paused: bool) -> Result<(), Error> {
        wpay_common::pause::set_paused(&env, &caller, paused)
    }

    pub fn is_paused(env: Env) -> bool {
        wpay_common::pause::is_paused(&env)
    }
}

#[cfg(test)]
mod test;
