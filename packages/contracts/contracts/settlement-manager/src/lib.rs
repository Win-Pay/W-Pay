//! # SettlementManager
//!
//! Batched merchant payouts. Operators open a settlement window for a token and
//! a period, append one entry per merchant, close the window, and execute it
//! once the contract holds enough of that token.
//!
//! ```text
//! open -> Open --(add entries)--close--> Closed --execute--> Executed
//!                          \--cancel--> Cancelled
//! ```
//!
//! Security assumptions:
//! * Only an `Operator` may open, populate, close and execute windows; only an
//!   admin may cancel. Funding is permissionless but cannot remove funds.
//! * A window is immutable once closed: entries can only be added while open,
//!   so an operator cannot change the payout list between closing and executing.
//! * Execution requires the contract's token pool to cover the whole window;
//!   a partially funded window reverts instead of paying some merchants first.
//! * Entry count is capped to keep the execute call within Soroban resource
//!   limits; larger runs must be split into several windows.
//! * The pool is tracked per token and never pays more than it holds.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Vec};
use wpay_common::{access, pause, tokens, validation, Error, Role};

pub const MAX_ENTRIES: u32 = 50;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WindowStatus {
    Open,
    Closed,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Entry {
    pub payee: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementWindow {
    pub id: u64,
    pub token: Address,
    pub period_start: u64,
    pub period_end: u64,
    pub entries: Vec<Entry>,
    pub total: i128,
    pub status: WindowStatus,
    pub created_at: u64,
    pub executed_at: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Window(u64),
    NextId,
    Count,
    Pool(Address),
}

#[contract]
pub struct SettlementManager;

#[contractimpl]
impl SettlementManager {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::NextId, &1u64);
        Ok(())
    }

    pub fn open_window(
        env: Env,
        operator: Address,
        token: Address,
        period_start: u64,
        period_end: u64,
    ) -> Result<u64, Error> {
        operator.require_auth();
        access::require_role(&env, Role::Operator, &operator)?;
        if period_start >= period_end {
            return Err(Error::InvalidInput);
        }
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        let window = SettlementWindow {
            id,
            token: token.clone(),
            period_start,
            period_end,
            entries: Vec::new(&env),
            total: 0,
            status: WindowStatus::Open,
            created_at: env.ledger().timestamp(),
            executed_at: None,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Window(id), &window);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        let count: u64 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        env.storage().instance().set(&DataKey::Count, &(count + 1));
        env.events().publish(
            (symbol_short!("open"), id),
            (token, period_start, period_end),
        );
        Ok(id)
    }

    pub fn add_entry(
        env: Env,
        operator: Address,
        window_id: u64,
        payee: Address,
        amount: i128,
    ) -> Result<i128, Error> {
        operator.require_auth();
        access::require_role(&env, Role::Operator, &operator)?;
        validation::require_positive(amount)?;
        let mut window = Self::get_window(env.clone(), window_id)?;
        if window.status != WindowStatus::Open {
            return Err(Error::WindowClosed);
        }
        if window.entries.len() >= MAX_ENTRIES {
            return Err(Error::LimitExceeded);
        }
        window.entries.push_back(Entry {
            payee: payee.clone(),
            amount,
        });
        window.total = window
            .total
            .checked_add(amount)
            .ok_or(Error::InvalidInput)?;
        env.storage()
            .persistent()
            .set(&DataKey::Window(window_id), &window);
        env.events()
            .publish((symbol_short!("entry"), window_id), (payee, amount));
        Ok(window.total)
    }

    pub fn close_window(env: Env, operator: Address, window_id: u64) -> Result<(), Error> {
        operator.require_auth();
        access::require_role(&env, Role::Operator, &operator)?;
        let mut window = Self::get_window(env.clone(), window_id)?;
        if window.status != WindowStatus::Open {
            return Err(Error::WindowClosed);
        }
        if window.entries.is_empty() {
            return Err(Error::InvalidState);
        }
        window.status = WindowStatus::Closed;
        env.storage()
            .persistent()
            .set(&DataKey::Window(window_id), &window);
        env.events().publish(
            (symbol_short!("close"), window_id),
            (window.entries.len(), window.total),
        );
        Ok(())
    }

    /// Adds `amount` of `token` to the contract's settlement pool.
    pub fn fund(env: Env, from: Address, token: Address, amount: i128) -> Result<i128, Error> {
        from.require_auth();
        validation::require_positive(amount)?;
        tokens::transfer(&env, &token, &from, &env.current_contract_address(), amount);
        let pool: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Pool(token.clone()))
            .unwrap_or(0);
        let pool = pool.checked_add(amount).ok_or(Error::InvalidInput)?;
        env.storage()
            .persistent()
            .set(&DataKey::Pool(token.clone()), &pool);
        env.events()
            .publish((symbol_short!("fund"), token), (from, amount, pool));
        Ok(pool)
    }

    /// Pays every entry in a closed window from the token pool.
    pub fn execute(env: Env, operator: Address, window_id: u64) -> Result<(), Error> {
        pause::require_not_paused(&env)?;
        operator.require_auth();
        access::require_role(&env, Role::Operator, &operator)?;
        let mut window = Self::get_window(env.clone(), window_id)?;
        if window.status != WindowStatus::Closed {
            return Err(Error::InvalidState);
        }
        let pool: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Pool(window.token.clone()))
            .unwrap_or(0);
        if pool < window.total {
            return Err(Error::InsufficientFunds);
        }

        for entry in window.entries.iter() {
            tokens::transfer(
                &env,
                &window.token,
                &env.current_contract_address(),
                &entry.payee,
                entry.amount,
            );
        }

        env.storage()
            .persistent()
            .set(&DataKey::Pool(window.token.clone()), &(pool - window.total));
        window.status = WindowStatus::Executed;
        window.executed_at = Some(env.ledger().timestamp());
        env.storage()
            .persistent()
            .set(&DataKey::Window(window_id), &window);
        env.events().publish(
            (symbol_short!("execute"), window_id),
            (operator, window.total),
        );
        Ok(())
    }

    /// Admin cancellation. An executed window can never be cancelled.
    pub fn cancel(env: Env, caller: Address, window_id: u64) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let mut window = Self::get_window(env.clone(), window_id)?;
        if window.status == WindowStatus::Executed {
            return Err(Error::InvalidState);
        }
        window.status = WindowStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Window(window_id), &window);
        env.events()
            .publish((symbol_short!("cancel"), window_id), caller);
        Ok(())
    }

    pub fn get_window(env: Env, id: u64) -> Result<SettlementWindow, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Window(id))
            .ok_or(Error::NotFound)
    }

    pub fn pool(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Pool(token))
            .unwrap_or(0)
    }

    pub fn count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
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
