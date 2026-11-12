//! # UpgradeManager
//!
//! Timelocked contract-upgrade proposals. A wasm hash is proposed, becomes
//! executable after [`MIN_DELAY_SECS`], and can be cancelled before execution.
//! The manager itself can upgrade its own wasm; for other contracts it is the
//! on-chain record of what hash is authorized, which operators then apply with
//! the target's own upgrade entry point.
//!
//! Security assumptions:
//! * Only an admin may propose, execute, cancel or self-upgrade.
//! * A proposal is executable strictly after the delay has elapsed; there is no
//!   path that installs code in the same transaction as the proposal.
//! * Re-proposing replaces the pending proposal and restarts the delay, so a
//!   compromised admin cannot "refresh" a proposal to make it instantly valid.
//! * Executing clears the proposal before the wasm update, so a failed update
//!   cannot leave an executable proposal behind.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env};
use wpay_common::{access, Error, Role};

pub const MIN_DELAY_SECS: u64 = 3_600;
pub const MAX_DELAY_SECS: u64 = 30 * 86_400;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    pub proposed_at: u64,
    pub executable_at: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Pending,
    Delay,
}

#[contract]
pub struct UpgradeManager;

#[contractimpl]
impl UpgradeManager {
    pub fn initialize(env: Env, admin: Address, delay_secs: u64) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        if !(MIN_DELAY_SECS..=MAX_DELAY_SECS).contains(&delay_secs) {
            return Err(Error::InvalidInput);
        }
        env.storage().instance().set(&DataKey::Delay, &delay_secs);
        Ok(())
    }

    /// Proposes (or replaces) a wasm hash. Starts a new timelock.
    pub fn propose(env: Env, caller: Address, wasm_hash: BytesN<32>) -> Result<u64, Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let delay = Self::delay(env.clone());
        let now = env.ledger().timestamp();
        let executable_at = now.checked_add(delay).ok_or(Error::InvalidInput)?;
        let pending = PendingUpgrade {
            wasm_hash: wasm_hash.clone(),
            proposed_at: now,
            executable_at,
        };
        env.storage().instance().set(&DataKey::Pending, &pending);
        env.events().publish(
            (symbol_short!("propose"),),
            (caller, wasm_hash, executable_at),
        );
        Ok(executable_at)
    }

    /// Returns the executable hash once the delay has elapsed and clears the
    /// pending proposal. Operators apply it to the target contract.
    pub fn execute(env: Env, caller: Address) -> Result<BytesN<32>, Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let pending = Self::get_pending(env.clone())?;
        if env.ledger().timestamp() < pending.executable_at {
            return Err(Error::TimelockNotElapsed);
        }
        env.storage().instance().remove(&DataKey::Pending);
        env.events().publish(
            (symbol_short!("execute"),),
            (caller, pending.wasm_hash.clone()),
        );
        Ok(pending.wasm_hash)
    }

    /// Applies the pending hash to this contract once the delay has elapsed.
    pub fn upgrade_self(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let pending = Self::get_pending(env.clone())?;
        if env.ledger().timestamp() < pending.executable_at {
            return Err(Error::TimelockNotElapsed);
        }
        env.storage().instance().remove(&DataKey::Pending);
        env.deployer()
            .update_current_contract_wasm(pending.wasm_hash.clone());
        env.events()
            .publish((symbol_short!("upgraded"),), (caller, pending.wasm_hash));
        Ok(())
    }

    pub fn cancel(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let pending = Self::get_pending(env.clone())?;
        env.storage().instance().remove(&DataKey::Pending);
        env.events()
            .publish((symbol_short!("cancel"),), (caller, pending.wasm_hash));
        Ok(())
    }

    pub fn pending(env: Env) -> Option<PendingUpgrade> {
        env.storage().instance().get(&DataKey::Pending)
    }

    /// True when a proposal exists and its delay has elapsed.
    pub fn is_ready(env: Env) -> bool {
        match Self::pending(env.clone()) {
            Some(pending) => env.ledger().timestamp() >= pending.executable_at,
            None => false,
        }
    }

    pub fn delay(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::Delay).unwrap_or(0)
    }

    pub fn grant_role(
        env: Env,
        caller: Address,
        role: Role,
        account: Address,
    ) -> Result<(), Error> {
        access::grant(&env, &caller, role, &account)
    }
}

impl UpgradeManager {
    fn get_pending(env: Env) -> Result<PendingUpgrade, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Pending)
            .ok_or(Error::NotFound)
    }
}

#[cfg(test)]
mod test;
