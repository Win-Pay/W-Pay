use super::*;
use soroban_sdk::testutils::Address as _;

fn setup() -> (Env, ConfigurationManagerClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(ConfigurationManager, ());
    let client = ConfigurationManagerClient::new(&env, &id);
    client.initialize(&admin);
    (env, client, admin)
}

#[test]
fn set_and_get_typed_values() {
    let (env, client, admin) = setup();
    let treasury = Address::generate(&env);

    client.set(&admin, &ConfigKey::PlatformFeeBps, &ConfigValue::U32(250));
    client.set(
        &admin,
        &ConfigKey::Treasury,
        &ConfigValue::Address(treasury.clone()),
    );

    assert_eq!(client.get_u32(&ConfigKey::PlatformFeeBps), 250);
    assert_eq!(client.get_address(&ConfigKey::Treasury), treasury);
    assert_eq!(client.version(), 3); // init + two writes
}

#[test]
fn missing_key_is_not_found() {
    let (_env, client, _admin) = setup();
    assert_eq!(
        client.try_get_u32(&ConfigKey::PlatformFeeBps),
        Err(Ok(Error::NotFound))
    );
    assert!(client.get(&ConfigKey::PlatformFeeBps).is_none());
}

#[test]
fn type_mismatch_is_reported() {
    let (env, client, admin) = setup();
    client.set(
        &admin,
        &ConfigKey::MinPaymentAmount,
        &ConfigValue::I128(100),
    );
    assert_eq!(
        client.try_get_u32(&ConfigKey::MinPaymentAmount),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn fee_ceiling_is_enforced() {
    let (_env, client, admin) = setup();
    assert_eq!(
        client.try_set(
            &admin,
            &ConfigKey::PlatformFeeBps,
            &ConfigValue::U32(ABSOLUTE_MAX_FEE_BPS + 1)
        ),
        Err(Ok(Error::LimitExceeded))
    );
}

#[test]
fn non_admin_cannot_write() {
    let (env, client, _admin) = setup();
    let stranger = Address::generate(&env);
    assert_eq!(
        client.try_set(&stranger, &ConfigKey::PlatformFeeBps, &ConfigValue::U32(1)),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn negative_minimum_payment_rejected() {
    let (_env, client, admin) = setup();
    assert_eq!(
        client.try_set(&admin, &ConfigKey::MinPaymentAmount, &ConfigValue::I128(-1)),
        Err(Ok(Error::InvalidInput))
    );
}
