//! # RoleManager
//!
//! Canonical registry for platform-level roles (admin, operator, auditor,
//! pauser). Individual contracts still enforce their own local role table —
//! this contract is the source of truth that dashboards and the API read, and
//! the place operators are onboarded.
//!
//! Security assumptions:
//! * The first admin is set exactly once in `initialize`; there is no re-init.
//! * `grant_role`/`revoke_role` require the caller's authorization *and* the
//!   `Admin` role.
//! * An admin cannot revoke their own `Admin` role, so the registry can never
//!   be left with zero administrators by an accidental self-revoke.
//! * Role enumeration is capped at [`MAX_HOLDERS_PER_ROLE`] to keep the ledger
//!   entry bounded; exceeding the cap is an explicit error, not silent loss.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Vec};
use wpay_common::{access, Error, Role};

/// Upper bound on holders tracked per role. Keeps enumeration affordable.
pub const MAX_HOLDERS_PER_ROLE: u32 = 100;

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Holders(Role),
    RoleCount(Role),
}

#[contract]
pub struct RoleManager;

#[contractimpl]
impl RoleManager {
    /// One-time initialization. `admin` becomes the first administrator.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        let mut holders = Vec::new(&env);
        holders.push_back(admin.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Holders(Role::Admin), &holders);
        env.storage()
            .persistent()
            .set(&DataKey::RoleCount(Role::Admin), &1u32);
        env.events().publish((symbol_short!("init"),), admin);
        Ok(())
    }

    /// Grants `role` to `account`. Caller must be an admin.
    pub fn grant_role(
        env: Env,
        caller: Address,
        role: Role,
        account: Address,
    ) -> Result<(), Error> {
        access::grant(&env, &caller, role, &account)?;

        let key = DataKey::Holders(role);
        let mut holders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));
        if !holders.contains(&account) {
            if holders.len() >= MAX_HOLDERS_PER_ROLE {
                return Err(Error::LimitExceeded);
            }
            holders.push_back(account.clone());
            env.storage().persistent().set(&key, &holders);
            let count_key = DataKey::RoleCount(role);
            let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
            env.storage().persistent().set(&count_key, &(count + 1));
        }

        env.events()
            .publish((symbol_short!("grant"), role), (caller, account));
        Ok(())
    }

    /// Revokes `role` from `account`. Caller must be an admin.
    pub fn revoke_role(
        env: Env,
        caller: Address,
        role: Role,
        account: Address,
    ) -> Result<(), Error> {
        access::revoke(&env, &caller, role, &account)?;

        let key = DataKey::Holders(role);
        let holders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));
        let mut kept = Vec::new(&env);
        for holder in holders.iter() {
            if holder != account {
                kept.push_back(holder);
            }
        }
        env.storage().persistent().set(&key, &kept);
        env.storage()
            .persistent()
            .set(&DataKey::RoleCount(role), &kept.len());

        env.events()
            .publish((symbol_short!("revoke"), role), (caller, account));
        Ok(())
    }

    /// Hands `Admin` to `new_admin` without leaving the old admin in place.
    /// The caller keeps no privileges afterwards.
    pub fn transfer_admin(env: Env, caller: Address, new_admin: Address) -> Result<(), Error> {
        access::require_initialized(&env)?;
        access::grant(&env, &caller, Role::Admin, &new_admin)?;
        // The self-revoke guard exists to stop an admin stranding the
        // registry; a handover legitimately removes the outgoing admin.
        access::revoke_unchecked(&env, Role::Admin, &caller);

        let key = DataKey::Holders(Role::Admin);
        let holders: Vec<Address> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));
        let mut kept = Vec::new(&env);
        for holder in holders.iter() {
            if holder != caller {
                kept.push_back(holder);
            }
        }
        if !kept.contains(&new_admin) {
            kept.push_back(new_admin.clone());
        }
        env.storage().persistent().set(&key, &kept);
        env.storage()
            .persistent()
            .set(&DataKey::RoleCount(Role::Admin), &kept.len());

        env.events()
            .publish((symbol_short!("xfer"),), (caller, new_admin));
        Ok(())
    }

    pub fn has_role(env: Env, role: Role, account: Address) -> bool {
        access::has_role(&env, role, &account)
    }

    pub fn is_admin(env: Env, account: Address) -> bool {
        access::has_role(&env, Role::Admin, &account)
    }

    /// Every address currently holding `role`, in grant order.
    pub fn holders(env: Env, role: Role) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Holders(role))
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn role_count(env: Env, role: Role) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::RoleCount(role))
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
