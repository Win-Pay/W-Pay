//! # FeeManager
//!
//! Platform fee policy: a default basis-point fee with per-merchant overrides,
//! and the arithmetic that splits a payment into platform fee and merchant net.
//!
//! Security assumptions:
//! * Fees can never exceed [`MAX_FEE_BPS`] (10%), checked on every write.
//! * `calculate` uses checked arithmetic and rejects negative or zero amounts,
//!   so an overflowing or nonsensical split is an error rather than a trap.
//! * Only an admin may change fees; the treasury address is advisory metadata
//!   consumed by settlement, this contract moves no funds.

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env};
use wpay_common::{access, validation, Error, FeeSplit, Role};

pub const MAX_FEE_BPS: u32 = 1_000;
pub const BPS_DENOMINATOR: i128 = 10_000;

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    DefaultFeeBps,
    MerchantFee(Address),
    Treasury,
}

#[contract]
pub struct FeeManager;

#[contractimpl]
impl FeeManager {
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        default_fee_bps: u32,
    ) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        validation::require_bps(default_fee_bps, MAX_FEE_BPS)?;
        env.storage()
            .instance()
            .set(&DataKey::DefaultFeeBps, &default_fee_bps);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.events()
            .publish((symbol_short!("init"),), (admin, default_fee_bps));
        Ok(())
    }

    pub fn set_default_fee(env: Env, caller: Address, bps: u32) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        validation::require_bps(bps, MAX_FEE_BPS)?;
        env.storage().instance().set(&DataKey::DefaultFeeBps, &bps);
        env.events().publish((symbol_short!("fee"), bps), caller);
        Ok(())
    }

    /// Sets (or clears with `None`) a merchant-specific fee. Admin only.
    pub fn set_merchant_fee(
        env: Env,
        caller: Address,
        merchant: Address,
        bps: Option<u32>,
    ) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        let key = DataKey::MerchantFee(merchant.clone());
        match bps {
            Some(bps) => {
                validation::require_bps(bps, MAX_FEE_BPS)?;
                env.storage().persistent().set(&key, &bps);
            }
            None => env.storage().persistent().remove(&key),
        }
        env.events().publish((symbol_short!("mfee"), merchant), bps);
        Ok(())
    }

    /// Effective fee for `merchant`: override if present, else the default.
    pub fn fee_bps_for(env: Env, merchant: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::MerchantFee(merchant))
            .unwrap_or_else(|| {
                env.storage()
                    .instance()
                    .get(&DataKey::DefaultFeeBps)
                    .unwrap_or(0)
            })
    }

    pub fn default_fee_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::DefaultFeeBps)
            .unwrap_or(0)
    }

    pub fn treasury(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(Error::NotInitialized)
    }

    /// Splits `amount` into `(fee, net)` for `merchant`.
    pub fn calculate(env: Env, merchant: Address, amount: i128) -> Result<FeeSplit, Error> {
        validation::require_positive(amount)?;
        let bps = Self::fee_bps_for(env, merchant);
        split(amount, bps)
    }

    /// Pure split calculation, useful for quoting before a payment exists.
    pub fn quote(env: Env, amount: i128, bps: u32) -> Result<FeeSplit, Error> {
        validation::require_positive(amount)?;
        validation::require_bps(bps, MAX_FEE_BPS)?;
        split(amount, bps)
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

/// `fee = amount * bps / 10_000`, rounded down so the platform never takes more
/// than the configured rate. `net` is the remainder, keeping the invariant
/// `fee + net == amount`.
fn split(amount: i128, bps: u32) -> Result<FeeSplit, Error> {
    let fee = amount
        .checked_mul(bps as i128)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR))
        .ok_or(Error::InvalidInput)?;
    let net = amount.checked_sub(fee).ok_or(Error::InvalidInput)?;
    Ok(FeeSplit { fee, net })
}

#[cfg(test)]
mod test;
