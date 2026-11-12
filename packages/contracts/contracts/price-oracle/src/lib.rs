//! # PriceOracle
//!
//! Operator-fed asset prices with a staleness window. Each asset has one price
//! quote (value plus decimals) and a timestamp; reads that require a current
//! price fail with [`Error::StalePrice`] instead of returning an old number.
//!
//! Security assumptions:
//! * Writes require `Operator` or `Admin`; a price of zero or a negative price
//!   is rejected, and decimals are capped at 18.
//! * `get_price` returns whatever is stored (for display); `fresh_price` is the
//!   getter consumers must use for accounting.
//! * `convert` refuses assets with different decimal precision rather than
//!   silently scaling, so a misconfigured asset cannot skew a conversion.
//! * There is no fallback oracle in this contract: an operator feeds prices.
//!   A production deployment must treat the operator key as a high-value secret
//!   and monitor `price_age`.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol};
use wpay_common::{access, Error, Role};

pub const MAX_DECIMALS: u32 = 18;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Price {
    pub asset: Symbol,
    pub price: i128,
    pub decimals: u32,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Price(Symbol),
    MaxAge,
}

#[contract]
pub struct PriceOracle;

#[contractimpl]
impl PriceOracle {
    pub fn initialize(env: Env, admin: Address, max_age_secs: u64) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        if max_age_secs == 0 {
            return Err(Error::InvalidInput);
        }
        env.storage()
            .instance()
            .set(&DataKey::MaxAge, &max_age_secs);
        Ok(())
    }

    /// Publishes a price. `price` is expressed in whole units of 10^-decimals.
    pub fn set_price(
        env: Env,
        caller: Address,
        asset: Symbol,
        price: i128,
        decimals: u32,
    ) -> Result<(), Error> {
        caller.require_auth();
        if !access::has_role(&env, Role::Operator, &caller)
            && !access::has_role(&env, Role::Admin, &caller)
        {
            return Err(Error::Unauthorized);
        }
        if price <= 0 {
            return Err(Error::InvalidInput);
        }
        if decimals > MAX_DECIMALS {
            return Err(Error::InvalidInput);
        }
        let quote = Price {
            asset: asset.clone(),
            price,
            decimals,
            updated_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Price(asset.clone()), &quote);
        env.events()
            .publish((symbol_short!("price"), asset), (price, decimals));
        Ok(())
    }

    /// Latest stored quote, however old.
    pub fn get_price(env: Env, asset: Symbol) -> Result<Price, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Price(asset))
            .ok_or(Error::NotFound)
    }

    /// Latest quote, rejected if older than `max_age`.
    pub fn fresh_price(env: Env, asset: Symbol) -> Result<Price, Error> {
        let quote = Self::get_price(env.clone(), asset)?;
        let age = env.ledger().timestamp().saturating_sub(quote.updated_at);
        if age > Self::max_age(env) {
            return Err(Error::StalePrice);
        }
        Ok(quote)
    }

    /// Converts `amount` of `from` into `to` using fresh quotes.
    /// Both assets must share decimal precision.
    pub fn convert(env: Env, amount: i128, from: Symbol, to: Symbol) -> Result<i128, Error> {
        if amount < 0 {
            return Err(Error::InvalidInput);
        }
        let source = Self::fresh_price(env.clone(), from)?;
        let target = Self::fresh_price(env, to)?;
        if source.decimals != target.decimals {
            return Err(Error::Unsupported);
        }
        amount
            .checked_mul(source.price)
            .and_then(|v| v.checked_div(target.price))
            .ok_or(Error::InvalidInput)
    }

    pub fn is_stale(env: Env, asset: Symbol) -> bool {
        match Self::get_price(env.clone(), asset) {
            Ok(quote) => {
                env.ledger().timestamp().saturating_sub(quote.updated_at) > Self::max_age(env)
            }
            Err(_) => true,
        }
    }

    pub fn max_age(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::MaxAge).unwrap_or(0)
    }

    pub fn set_max_age(env: Env, caller: Address, max_age_secs: u64) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        if max_age_secs == 0 {
            return Err(Error::InvalidInput);
        }
        env.storage()
            .instance()
            .set(&DataKey::MaxAge, &max_age_secs);
        env.events()
            .publish((symbol_short!("maxage"),), (caller, max_age_secs));
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

#[cfg(test)]
mod test;
