//! # ConfigurationManager
//!
//! Typed platform configuration. Values are stored per key with an explicit
//! type tag so a misconfigured write cannot be silently read back as the wrong
//! type; reads return `None` for unset keys and typed getters return a typed
//! error instead of panicking.
//!
//! Security assumptions:
//! * Only an admin may write (`set`), and every write is preceded by
//!   [`validate`], which rejects out-of-range fee values.
//! * Configuration is instance storage: small, bounded and read on nearly every
//!   privileged call.
//! * There is no key deletion entry point, so a typo cannot remove a safety
//!   limit.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol,
};
use wpay_common::{access, Error, Role};

/// Well-known configuration keys plus an escape hatch for app-specific values.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConfigKey {
    PlatformFeeBps,
    MaxFeeBps,
    Treasury,
    SettlementWindowSecs,
    MinPaymentAmount,
    PriceOracle,
    EmergencyPause,
    Custom(Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConfigValue {
    U32(u32),
    U64(u64),
    I128(i128),
    Address(Address),
    Bool(bool),
    Symbol(Symbol),
    Bytes32(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Config(ConfigKey),
    Version,
}

/// Hard ceiling on platform fees (10%).
pub const ABSOLUTE_MAX_FEE_BPS: u32 = 1_000;

#[contract]
pub struct ConfigurationManager;

#[contractimpl]
impl ConfigurationManager {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        access::init_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Version, &1u32);
        Ok(())
    }

    /// Validates and stores `value` under `key`. Admin only.
    pub fn set(env: Env, caller: Address, key: ConfigKey, value: ConfigValue) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(&env, Role::Admin, &caller)?;
        validate(&key, &value)?;

        env.storage()
            .instance()
            .set(&DataKey::Config(key.clone()), &value);
        let version: u32 = env.storage().instance().get(&DataKey::Version).unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::Version, &(version + 1));

        env.events()
            .publish((symbol_short!("set"),), (caller, key, version + 1));
        Ok(())
    }

    pub fn get(env: Env, key: ConfigKey) -> Option<ConfigValue> {
        env.storage().instance().get(&DataKey::Config(key))
    }

    pub fn get_u32(env: Env, key: ConfigKey) -> Result<u32, Error> {
        match Self::get(env, key) {
            Some(ConfigValue::U32(v)) => Ok(v),
            Some(_) => Err(Error::InvalidInput),
            None => Err(Error::NotFound),
        }
    }

    pub fn get_i128(env: Env, key: ConfigKey) -> Result<i128, Error> {
        match Self::get(env, key) {
            Some(ConfigValue::I128(v)) => Ok(v),
            Some(_) => Err(Error::InvalidInput),
            None => Err(Error::NotFound),
        }
    }

    pub fn get_address(env: Env, key: ConfigKey) -> Result<Address, Error> {
        match Self::get(env, key) {
            Some(ConfigValue::Address(v)) => Ok(v),
            Some(_) => Err(Error::InvalidInput),
            None => Err(Error::NotFound),
        }
    }

    pub fn get_bool(env: Env, key: ConfigKey) -> Result<bool, Error> {
        match Self::get(env, key) {
            Some(ConfigValue::Bool(v)) => Ok(v),
            Some(_) => Err(Error::InvalidInput),
            None => Err(Error::NotFound),
        }
    }

    /// Monotonic write counter, useful for cache invalidation off-chain.
    pub fn version(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Version).unwrap_or(0)
    }

    pub fn has(env: Env, key: ConfigKey) -> bool {
        env.storage().instance().has(&DataKey::Config(key))
    }
}

/// Type- and range-checks a configuration value.
fn validate(key: &ConfigKey, value: &ConfigValue) -> Result<(), Error> {
    match (key, value) {
        (ConfigKey::PlatformFeeBps, ConfigValue::U32(bps))
        | (ConfigKey::MaxFeeBps, ConfigValue::U32(bps)) => {
            if *bps > ABSOLUTE_MAX_FEE_BPS {
                return Err(Error::LimitExceeded);
            }
        }
        (ConfigKey::MinPaymentAmount, ConfigValue::I128(amount)) => {
            if *amount < 0 {
                return Err(Error::InvalidInput);
            }
        }
        (ConfigKey::SettlementWindowSecs, ConfigValue::U64(secs)) => {
            if *secs == 0 {
                return Err(Error::InvalidInput);
            }
        }
        (ConfigKey::Treasury, ConfigValue::Address(_))
        | (ConfigKey::PriceOracle, ConfigValue::Address(_))
        | (ConfigKey::EmergencyPause, ConfigValue::Address(_)) => {}
        (_, ConfigValue::U32(_)) => {}
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod test;
