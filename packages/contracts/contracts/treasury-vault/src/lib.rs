//! # TreasuryVault
//!
//! Custody for platform funds. All deposits are permissionless; every outflow
//! needs an admin authorization, and anything above a per-token threshold must
//! be scheduled and wait out a timelock before it can be executed.
//!
//! Security assumptions:
//! * Balances are tracked per token in persistent storage and every withdrawal
//!   is checked against the tracked balance, so the vault can never overdraw.
//! * A withdrawal at or below the token threshold is immediate; above it the
//!   only path is `schedule_withdrawal` + `execute_withdrawal` after
//!   [`TIMELOCK_SECS`]. This gives operators time to notice a compromised admin
//!   key and cancel.
//! * A scheduled withdrawal can be cancelled by an admin until it executes.
//! * Pausing blocks withdrawals and scheduling but never blocks deposits, so
//!   fees already routed to the treasury are not lost during an incident.
//! * The timelock is a constant, not a settable parameter: shortening it would
//!   defeat its purpose, and changing it requires a contract upgrade.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env};
use wpay_common::{access, pause, tokens, validation, Error, Role};

/// Delay applied to withdrawals above the token threshold (24 hours).
pub const TIMELOCK_SECS: u64 = 86_400;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WithdrawalStatus {
    Scheduled,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledWithdrawal {
    pub id: u64,
    pub token: Address,
    pub to: Address,
    pub amount: i128,
    pub execute_after: u64,
    pub status: WithdrawalStatus,
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Balance(Address),
    Threshold(Address),
    Withdrawal(u64),
    NextWithdrawalId,
}

#[contract]
pub struct TreasuryVault;

#[contractimpl]
impl TreasuryVault {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        env.storage()
            .instance()
            .set(&DataKey::NextWithdrawalId, &1u64);
        Ok(())
    }

    /// Adds `amount` of `token` to the vault. Anyone may fund the treasury.
    pub fn deposit(env: Env, from: Address, token: Address, amount: i128) -> Result<i128, Error> {
        from.require_auth();
        validation::require_positive(amount)?;
        tokens::transfer(&env, &token, &from, &env.current_contract_address(), amount);
        let balance = Self::credit(&env, &token, amount)?;
        env.events()
            .publish((symbol_short!("deposit"), token), (from, amount, balance));
        Ok(balance)
    }

    /// Immediate withdrawal for amounts at or below the token threshold.
    pub fn withdraw(
        env: Env,
        caller: Address,
        token: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        pause::require_not_paused(&env)?;
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        validation::require_positive(amount)?;
        if amount > Self::threshold(env.clone(), token.clone()) {
            return Err(Error::TimelockActive);
        }
        Self::debit(&env, &token, amount)?;
        tokens::transfer(&env, &token, &env.current_contract_address(), &to, amount);
        env.events()
            .publish((symbol_short!("withdraw"), token), (to, amount, caller));
        Ok(())
    }

    /// Schedules an unlimited withdrawal that may execute after the timelock.
    pub fn schedule_withdrawal(
        env: Env,
        caller: Address,
        token: Address,
        to: Address,
        amount: i128,
    ) -> Result<u64, Error> {
        pause::require_not_paused(&env)?;
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        validation::require_positive(amount)?;
        if amount > Self::balance(env.clone(), token.clone()) {
            return Err(Error::InsufficientFunds);
        }
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextWithdrawalId)
            .unwrap_or(1);
        let withdrawal = ScheduledWithdrawal {
            id,
            token: token.clone(),
            to,
            amount,
            execute_after: env.ledger().timestamp() + TIMELOCK_SECS,
            status: WithdrawalStatus::Scheduled,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Withdrawal(id), &withdrawal);
        env.storage()
            .instance()
            .set(&DataKey::NextWithdrawalId, &(id + 1));
        env.events().publish(
            (symbol_short!("schedule"), id),
            (token, amount, withdrawal.execute_after),
        );
        Ok(id)
    }

    pub fn execute_withdrawal(env: Env, caller: Address, withdrawal_id: u64) -> Result<(), Error> {
        pause::require_not_paused(&env)?;
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let mut withdrawal = Self::get_withdrawal(env.clone(), withdrawal_id)?;
        if withdrawal.status != WithdrawalStatus::Scheduled {
            return Err(Error::InvalidState);
        }
        if env.ledger().timestamp() < withdrawal.execute_after {
            return Err(Error::TimelockNotElapsed);
        }
        Self::debit(&env, &withdrawal.token, withdrawal.amount)?;
        tokens::transfer(
            &env,
            &withdrawal.token,
            &env.current_contract_address(),
            &withdrawal.to,
            withdrawal.amount,
        );
        withdrawal.status = WithdrawalStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Withdrawal(withdrawal_id), &withdrawal);
        env.events().publish(
            (symbol_short!("executed"), withdrawal_id),
            (withdrawal.to, withdrawal.amount),
        );
        Ok(())
    }

    pub fn cancel_withdrawal(env: Env, caller: Address, withdrawal_id: u64) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let mut withdrawal = Self::get_withdrawal(env.clone(), withdrawal_id)?;
        if withdrawal.status != WithdrawalStatus::Scheduled {
            return Err(Error::InvalidState);
        }
        withdrawal.status = WithdrawalStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Withdrawal(withdrawal_id), &withdrawal);
        env.events()
            .publish((symbol_short!("cancelwd"), withdrawal_id), caller);
        Ok(())
    }

    pub fn set_threshold(
        env: Env,
        caller: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        if amount < 0 {
            return Err(Error::InvalidInput);
        }
        env.storage()
            .instance()
            .set(&DataKey::Threshold(token.clone()), &amount);
        env.events()
            .publish((symbol_short!("threshold"), token), (caller, amount));
        Ok(())
    }

    pub fn balance(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(token))
            .unwrap_or(0)
    }

    pub fn threshold(env: Env, token: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold(token))
            .unwrap_or(0)
    }

    pub fn get_withdrawal(env: Env, id: u64) -> Result<ScheduledWithdrawal, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Withdrawal(id))
            .ok_or(Error::NotFound)
    }

    pub fn next_withdrawal_id(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::NextWithdrawalId)
            .unwrap_or(1)
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

impl TreasuryVault {
    fn credit(env: &Env, token: &Address, amount: i128) -> Result<i128, Error> {
        let balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(token.clone()))
            .unwrap_or(0);
        let balance = balance.checked_add(amount).ok_or(Error::InvalidInput)?;
        env.storage()
            .persistent()
            .set(&DataKey::Balance(token.clone()), &balance);
        Ok(balance)
    }

    fn debit(env: &Env, token: &Address, amount: i128) -> Result<(), Error> {
        let balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(token.clone()))
            .unwrap_or(0);
        if balance < amount {
            return Err(Error::InsufficientFunds);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Balance(token.clone()), &(balance - amount));
        Ok(())
    }
}

#[cfg(test)]
mod test;
