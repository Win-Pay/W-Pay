use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{symbol_short, Env};

struct World {
    env: Env,
    oracle: PriceOracleClient<'static>,
    admin: Address,
    operator: Address,
}

fn world() -> World {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let id = env.register(PriceOracle, ());
    let oracle = PriceOracleClient::new(&env, &id);
    oracle.initialize(&admin, &300);
    oracle.grant_role(&admin, &Role::Operator, &operator);
    World {
        env,
        oracle,
        admin,
        operator,
    }
}

#[test]
fn operator_publishes_and_reads_price() {
    let w = world();
    let usdc = symbol_short!("USDC");
    w.oracle.set_price(&w.operator, &usdc, &1_000_000, &6);
    let quote = w.oracle.get_price(&usdc);
    assert_eq!(quote.price, 1_000_000);
    assert_eq!(quote.decimals, 6);
    assert_eq!(quote.updated_at, 1_000);
    assert!(!w.oracle.is_stale(&usdc));
}

#[test]
fn non_operator_cannot_publish() {
    let w = world();
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.oracle
            .try_set_price(&stranger, &symbol_short!("USDC"), &1, &6),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn invalid_quotes_rejected() {
    let w = world();
    let usdc = symbol_short!("USDC");
    assert_eq!(
        w.oracle.try_set_price(&w.operator, &usdc, &0, &6),
        Err(Ok(Error::InvalidInput))
    );
    assert_eq!(
        w.oracle.try_set_price(&w.operator, &usdc, &-1, &6),
        Err(Ok(Error::InvalidInput))
    );
    assert_eq!(
        w.oracle
            .try_set_price(&w.operator, &usdc, &1, &(MAX_DECIMALS + 1)),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn stale_prices_are_refused_for_accounting() {
    let w = world();
    let usdc = symbol_short!("USDC");
    w.oracle.set_price(&w.operator, &usdc, &1_000_000, &6);
    w.env.ledger().set_timestamp(1_000 + 301);
    assert!(w.oracle.is_stale(&usdc));
    assert_eq!(w.oracle.try_fresh_price(&usdc), Err(Ok(Error::StalePrice)));
    // The display getter still returns the last quote.
    assert_eq!(w.oracle.get_price(&usdc).price, 1_000_000);

    w.oracle.set_price(&w.operator, &usdc, &1_000_100, &6);
    assert_eq!(w.oracle.fresh_price(&usdc).price, 1_000_100);
}

#[test]
fn convert_uses_fresh_quotes() {
    let w = world();
    let usdc = symbol_short!("USDC");
    let eurc = symbol_short!("EURC");
    w.oracle.set_price(&w.operator, &usdc, &1_000_000, &6);
    w.oracle.set_price(&w.operator, &eurc, &1_100_000, &6);
    // 1 USDC (in micro units) is worth 1/1.1 EURC.
    assert_eq!(w.oracle.convert(&1_000_000, &usdc, &eurc), 909_090);
}

#[test]
fn convert_refuses_mismatched_decimals() {
    let w = world();
    let usdc = symbol_short!("USDC");
    let xlm = symbol_short!("XLM");
    w.oracle.set_price(&w.operator, &usdc, &1_000_000, &6);
    w.oracle.set_price(&w.operator, &xlm, &10_000_000, &7);
    assert_eq!(
        w.oracle.try_convert(&1, &usdc, &xlm),
        Err(Ok(Error::Unsupported))
    );
}

#[test]
fn unknown_asset_is_not_found() {
    let w = world();
    assert_eq!(
        w.oracle.try_get_price(&symbol_short!("NONE")),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn only_admin_changes_max_age() {
    let w = world();
    assert_eq!(
        w.oracle.try_set_max_age(&w.operator, &10),
        Err(Ok(Error::Unauthorized))
    );
    w.oracle.set_max_age(&w.admin, &10);
    assert_eq!(w.oracle.max_age(), 10);
    assert_eq!(
        w.oracle.try_set_max_age(&w.admin, &0),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn zero_max_age_rejected_at_init() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(PriceOracle, ());
    let oracle = PriceOracleClient::new(&env, &id);
    assert_eq!(
        oracle.try_initialize(&admin, &0),
        Err(Ok(Error::InvalidInput))
    );
}
