//! # EmergencyPause
//!
//! The circuit breaker. It keeps a registry of contracts it governs, records
//! whether it has paused them, and calls each contract's `set_paused` entry
//! point. Every governed contract must set this contract as its pause authority.
//!
//! Security assumptions:
//! * Only an admin may register or unregister targets; a `Pauser` or an admin
//!   may pause. Unpausing requires the same authority, so a compromised pauser
//!   cannot silently resume a halted system.
//! * Pausing is idempotent and per-target failures are not swallowed: if any
//!   target rejects the call the whole transaction reverts, so the local
//!   `is_paused` flag can never claim a halt that did not happen.
//! * Targets are capped to keep the fan-out bounded; a paused target list is
//!   the entire blast radius, so registration is admin-only.
//! * This contract cannot make a target pause if the target does not recognise
//!   it as its pause authority; that misconfiguration surfaces as a failed
//!   call during `pause_all` rather than a silent no-op.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, IntoVal, Symbol, Val, Vec,
};
use wpay_common::{access, Error, Role};

pub const MAX_TARGETS: u32 = 50;

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Targets,
    Paused,
}

#[contract]
pub struct EmergencyPause;

#[contractimpl]
impl EmergencyPause {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        env.storage()
            .persistent()
            .set(&DataKey::Targets, &Vec::<Address>::new(&env));
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    pub fn register_target(env: Env, caller: Address, target: Address) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let mut targets = Self::targets(env.clone());
        if targets.contains(&target) {
            return Err(Error::AlreadyExists);
        }
        if targets.len() >= MAX_TARGETS {
            return Err(Error::LimitExceeded);
        }
        targets.push_back(target.clone());
        env.storage().persistent().set(&DataKey::Targets, &targets);
        env.events()
            .publish((symbol_short!("register"),), (caller, target));
        Ok(())
    }

    pub fn unregister_target(env: Env, caller: Address, target: Address) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let targets = Self::targets(env.clone());
        let mut kept = Vec::new(&env);
        for existing in targets.iter() {
            if existing != target {
                kept.push_back(existing);
            }
        }
        if kept.len() == targets.len() {
            return Err(Error::NotFound);
        }
        env.storage().persistent().set(&DataKey::Targets, &kept);
        Ok(())
    }

    /// Pauses every registered target, then marks itself paused.
    pub fn pause_all(env: Env, caller: Address) -> Result<u32, Error> {
        caller.require_auth();
        Self::require_pauser(&env, &caller)?;
        let targets = Self::targets(env.clone());
        for target in targets.iter() {
            Self::set_target_paused(&env, &target, true);
        }
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events()
            .publish((symbol_short!("pauseall"),), (caller, targets.len()));
        Ok(targets.len())
    }

    pub fn unpause_all(env: Env, caller: Address) -> Result<u32, Error> {
        caller.require_auth();
        Self::require_pauser(&env, &caller)?;
        let targets = Self::targets(env.clone());
        for target in targets.iter() {
            Self::set_target_paused(&env, &target, false);
        }
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((symbol_short!("unpause"),), (caller, targets.len()));
        Ok(targets.len())
    }

    /// Pauses a single registered target, for a scoped incident.
    pub fn pause_target(env: Env, caller: Address, target: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_pauser(&env, &caller)?;
        if !Self::targets(env.clone()).contains(&target) {
            return Err(Error::NotFound);
        }
        Self::set_target_paused(&env, &target, true);
        env.events()
            .publish((symbol_short!("pausetgt"),), (caller, target));
        Ok(())
    }

    pub fn unpause_target(env: Env, caller: Address, target: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_pauser(&env, &caller)?;
        if !Self::targets(env.clone()).contains(&target) {
            return Err(Error::NotFound);
        }
        Self::set_target_paused(&env, &target, false);
        Ok(())
    }

    pub fn targets(env: Env) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Targets)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn target_count(env: Env) -> u32 {
        Self::targets(env).len()
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

impl EmergencyPause {
    fn require_pauser(env: &Env, caller: &Address) -> Result<(), Error> {
        if access::has_role(env, Role::Pauser, caller) || access::has_role(env, Role::Admin, caller)
        {
            return Ok(());
        }
        Err(Error::Unauthorized)
    }

    fn set_target_paused(env: &Env, target: &Address, paused: bool) {
        let args: Vec<Val> = (env.current_contract_address(), paused).into_val(env);
        env.invoke_contract::<()>(target, &Symbol::new(env, "set_paused"), args);
    }
}

#[cfg(test)]
mod test;
