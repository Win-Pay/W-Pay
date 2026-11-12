//! Shared primitives for W-Pay Soroban contracts.
//!
//! Every contract in this workspace stores its own state, so these storage keys
//! never collide across contracts. Keeping role, pause and validation logic in
//! one place means a security fix only has to be made once.

#![no_std]

use soroban_sdk::{contractclient, contracterror, contracttype, Address, Env, String};

/// Errors shared by every W-Pay contract.
///
/// Codes are stable and part of the public ABI: clients map them to messages,
/// so never renumber an existing variant.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    NotFound = 4,
    InvalidInput = 5,
    Paused = 6,
    InsufficientFunds = 7,
    InvalidState = 8,
    Expired = 9,
    LimitExceeded = 10,
    AlreadyExists = 11,
    NotPaused = 12,
    TimelockActive = 13,
    StalePrice = 14,
    AlreadyVoted = 15,
    QuorumNotMet = 16,
    TimelockNotElapsed = 17,
    WindowClosed = 18,
    Unsupported = 19,
}

/// Permission roles. `Admin` is bootstrapped at initialization; the rest are
/// granted by an admin through [`access::grant`].
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Role {
    Admin,
    Operator,
    Merchant,
    Auditor,
    Pauser,
}

/// Fee split for a payment: the platform keeps `fee`, the merchant receives
/// `net`. Invariant: `fee + net == amount`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeSplit {
    pub fee: i128,
    pub net: i128,
}

/// Payment lifecycle as recorded by `PaymentRouter`.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PaymentStatus {
    Settled,
    PartiallyRefunded,
    Refunded,
}

/// A routed payment. Shared so consuming contracts (refunds, invoices) can read
/// a router record without duplicating the XDR shape.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payment {
    pub id: u64,
    pub merchant_id: u64,
    pub payer: Address,
    pub token: Address,
    pub amount: i128,
    pub fee: i128,
    pub net: i128,
    pub refunded: i128,
    pub memo: String,
    pub created_at: u64,
    pub status: PaymentStatus,
}

/// Merchant lifecycle, shared so that consuming contracts can decode registry
/// records without duplicating the XDR shape.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MerchantStatus {
    Pending,
    Active,
    Suspended,
    Closed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Merchant {
    pub id: u64,
    pub owner: Address,
    pub settlement: Address,
    pub name: String,
    pub fee_bps: u32,
    pub status: MerchantStatus,
    pub created_at: u64,
}

/// Read-only view of `FeeManager` used by contracts that split a payment.
///
/// Declaring the interface here (rather than depending on the contract crate)
/// keeps each WASM binary free of its neighbours' code.
#[contractclient(name = "FeeManagerClient")]
pub trait FeeManagerInterface {
    fn calculate(env: Env, merchant: Address, amount: i128) -> Result<FeeSplit, Error>;
    fn treasury(env: Env) -> Result<Address, Error>;
}

/// Read-only view of `MerchantRegistry` used by the money-path contracts.
#[contractclient(name = "RegistryClient")]
pub trait MerchantRegistryInterface {
    fn get(env: Env, id: u64) -> Result<Merchant, Error>;
    fn is_active(env: Env, id: u64) -> bool;
}

/// View of `PaymentRouter` used by `InvoiceManager` and `RefundManager`.
#[contractclient(name = "RouterClient")]
pub trait PaymentRouterInterface {
    fn create_payment(
        env: Env,
        payer: Address,
        merchant_id: u64,
        token: Address,
        amount: i128,
        memo: String,
    ) -> Result<u64, Error>;

    fn get_payment(env: Env, payment_id: u64) -> Result<Payment, Error>;

    fn record_refund(
        env: Env,
        caller: Address,
        payment_id: u64,
        amount: i128,
    ) -> Result<i128, Error>;
}

#[contracttype]
#[derive(Clone, Debug)]
pub enum Key {
    /// Role membership for an address.
    Role(Role, Address),
    /// Set once the contract has been initialized.
    Initialized,
    /// Address allowed to pause this contract (normally EmergencyPause).
    PauseAuthority,
    /// Local pause flag.
    Paused,
}

/// Role based access control backed by instance storage.
///
/// Instance storage is deliberately used: role sets are small and bounded, and
/// every privileged call needs the entry anyway, so this avoids an extra
/// persistent-entry read on the hot path.
pub mod access {
    use super::{Error, Key, Role};
    use soroban_sdk::{Address, Env};

    /// Records `admin` as the first administrator. Fails if already set, which
    /// makes re-initialization (and initialization front-running) impossible.
    pub fn init_admin(env: &Env, admin: &Address) -> Result<(), Error> {
        if env.storage().instance().has(&Key::Initialized) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&Key::Initialized, &true);
        env.storage()
            .instance()
            .set(&Key::Role(Role::Admin, admin.clone()), &true);
        Ok(())
    }

    /// True once `init_admin` has run.
    pub fn is_initialized(env: &Env) -> bool {
        env.storage().instance().has(&Key::Initialized)
    }

    /// Grants `role` to `account`. The caller must authorize and hold `Admin`.
    pub fn grant(env: &Env, caller: &Address, role: Role, account: &Address) -> Result<(), Error> {
        caller.require_auth();
        require_role(env, Role::Admin, caller)?;
        env.storage()
            .instance()
            .set(&Key::Role(role, account.clone()), &true);
        Ok(())
    }

    /// Revokes `role` from `account`. The caller must hold `Admin`.
    ///
    /// An admin cannot revoke their own `Admin` role, which prevents a contract
    /// from being locked out of privileged operations by a single mistake.
    pub fn revoke(env: &Env, caller: &Address, role: Role, account: &Address) -> Result<(), Error> {
        caller.require_auth();
        require_role(env, Role::Admin, caller)?;
        if role == Role::Admin && caller == account {
            return Err(Error::InvalidInput);
        }
        env.storage()
            .instance()
            .remove(&Key::Role(role, account.clone()));
        Ok(())
    }

    /// Removes a role without an authorization check.
    ///
    /// Reserved for flows that have already authorized their caller and need to
    /// bypass the self-revoke guard, such as handing `Admin` over. Never expose
    /// this directly as a contract entry point.
    pub fn revoke_unchecked(env: &Env, role: Role, account: &Address) {
        env.storage()
            .instance()
            .remove(&Key::Role(role, account.clone()));
    }

    pub fn has_role(env: &Env, role: Role, account: &Address) -> bool {
        env.storage()
            .instance()
            .get::<Key, bool>(&Key::Role(role, account.clone()))
            .unwrap_or(false)
    }

    /// Reverts with [`Error::Unauthorized`] unless `account` holds `role`.
    pub fn require_role(env: &Env, role: Role, account: &Address) -> Result<(), Error> {
        if !has_role(env, role, account) {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    /// Reverts unless the contract has been initialized.
    pub fn require_initialized(env: &Env) -> Result<(), Error> {
        if !is_initialized(env) {
            return Err(Error::NotInitialized);
        }
        Ok(())
    }
}

/// Local pause switch.
///
/// Pausing is intentionally *local* to each contract: a global flag that every
/// contract read cross-contract would add an inter-contract call to the hot
/// path and create a single point of failure. `EmergencyPause` holds the
/// registry and calls [`set_paused`] on each contract it governs.
pub mod pause {
    use super::{access, Error, Key, Role};
    use soroban_sdk::{Address, Env};

    /// Sets the address permitted to pause/unpause (typically the
    /// `EmergencyPause` contract). Caller must hold `Admin`.
    pub fn set_authority(env: &Env, caller: &Address, authority: &Address) -> Result<(), Error> {
        caller.require_auth();
        access::require_role(env, Role::Admin, caller)?;
        env.storage()
            .instance()
            .set(&Key::PauseAuthority, authority);
        Ok(())
    }

    pub fn authority(env: &Env) -> Option<Address> {
        env.storage().instance().get(&Key::PauseAuthority)
    }

    /// Flips the pause flag. The caller must authorize and be either the
    /// configured pause authority or an admin of this contract.
    pub fn set_paused(env: &Env, caller: &Address, paused: bool) -> Result<(), Error> {
        caller.require_auth();
        let is_authority = authority(env).map(|a| &a == caller).unwrap_or(false);
        if !is_authority {
            access::require_role(env, Role::Admin, caller)?;
        }
        env.storage().instance().set(&Key::Paused, &paused);
        Ok(())
    }

    pub fn is_paused(env: &Env) -> bool {
        env.storage()
            .instance()
            .get::<Key, bool>(&Key::Paused)
            .unwrap_or(false)
    }

    /// Reverts with [`Error::Paused`] while the contract is paused.
    pub fn require_not_paused(env: &Env) -> Result<(), Error> {
        if is_paused(env) {
            return Err(Error::Paused);
        }
        Ok(())
    }
}

/// Thin wrappers over the Stellar token interface.
///
/// Contracts never assume a specific asset implementation: they hold a token
/// `Address` and call the standard token interface, which both Stellar Asset
/// Contracts and compliant custom tokens implement. Movements of zero are
/// skipped so an empty fee leg cannot fail a payment.
pub mod tokens {
    use soroban_sdk::{token, Address, Env};

    pub fn balance(env: &Env, token: &Address, account: &Address) -> i128 {
        token::Client::new(env, token).balance(account)
    }

    pub fn transfer(env: &Env, token: &Address, from: &Address, to: &Address, amount: i128) {
        if amount == 0 {
            return;
        }
        token::Client::new(env, token).transfer(from, to, &amount);
    }

    /// Moves `amount` from `from` using an allowance granted to `spender`.
    pub fn transfer_from(
        env: &Env,
        token: &Address,
        spender: &Address,
        from: &Address,
        to: &Address,
        amount: i128,
    ) {
        if amount == 0 {
            return;
        }
        token::Client::new(env, token).transfer_from(spender, from, to, &amount);
    }
}

/// Input validation helpers shared by the contracts.
pub mod validation {
    use super::Error;

    /// Rejects zero and negative amounts. Soroban amounts are i128 stroops.
    pub fn require_positive(amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidInput);
        }
        Ok(())
    }

    /// Rejects basis points outside `0..=max_bps` with [`Error::LimitExceeded`],
    /// which callers surface as "fee too high" rather than a malformed request.
    pub fn require_bps(bps: u32, max_bps: u32) -> Result<(), Error> {
        if bps > max_bps {
            return Err(Error::LimitExceeded);
        }
        Ok(())
    }

    /// Rejects a deadline that is not strictly in the future.
    pub fn require_future(env: &soroban_sdk::Env, timestamp: u64) -> Result<(), Error> {
        if timestamp <= env.ledger().timestamp() {
            return Err(Error::InvalidInput);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{contract, contractimpl, Env};

    // Storage helpers may only run inside a contract context, so the tests
    // execute their assertions inside a registered no-op harness contract.
    #[contract]
    pub struct Harness;

    #[contractimpl]
    impl Harness {}

    fn harness(env: &Env) -> soroban_sdk::Address {
        env.register(Harness, ())
    }

    #[test]
    fn admin_is_granted_once() {
        let env = Env::default();
        env.mock_all_auths();
        let id = harness(&env);
        let admin = Address::generate(&env);
        env.as_contract(&id, || {
            access::init_admin(&env, &admin).unwrap();
            assert!(access::has_role(&env, Role::Admin, &admin));
            assert_eq!(
                access::init_admin(&env, &admin),
                Err(Error::AlreadyInitialized)
            );
        });
    }

    #[test]
    fn non_admin_cannot_grant() {
        let env = Env::default();
        env.mock_all_auths();
        let id = harness(&env);
        let admin = Address::generate(&env);
        let stranger = Address::generate(&env);
        let target = Address::generate(&env);
        env.as_contract(&id, || {
            access::init_admin(&env, &admin).unwrap();
            assert_eq!(
                access::grant(&env, &stranger, Role::Operator, &target),
                Err(Error::Unauthorized)
            );
            access::grant(&env, &admin, Role::Operator, &target).unwrap();
            assert!(access::has_role(&env, Role::Operator, &target));
        });
    }

    #[test]
    fn admin_cannot_revoke_self() {
        let env = Env::default();
        env.mock_all_auths();
        let id = harness(&env);
        let admin = Address::generate(&env);
        env.as_contract(&id, || {
            access::init_admin(&env, &admin).unwrap();
            assert_eq!(
                access::revoke(&env, &admin, Role::Admin, &admin),
                Err(Error::InvalidInput)
            );
        });
    }

    #[test]
    fn positive_amounts_only() {
        assert_eq!(validation::require_positive(0), Err(Error::InvalidInput));
        assert_eq!(validation::require_positive(-5), Err(Error::InvalidInput));
        assert!(validation::require_positive(1).is_ok());
        assert!(validation::require_bps(1_001, 1_000).is_err());
    }
}
