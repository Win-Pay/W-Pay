use super::*;
use soroban_sdk::testutils::Address as _;

fn setup() -> (Env, FeeManagerClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let id = env.register(FeeManager, ());
    let client = FeeManagerClient::new(&env, &id);
    client.initialize(&admin, &treasury, &250);
    (env, client, admin, treasury)
}

#[test]
fn default_fee_applies() {
    let (env, client, _admin, _treasury) = setup();
    let merchant = Address::generate(&env);
    assert_eq!(client.fee_bps_for(&merchant), 250);
    assert_eq!(client.treasury(), _treasury);
}

#[test]
fn split_is_exact_and_rounds_down() {
    let (env, client, _admin, _treasury) = setup();
    let merchant = Address::generate(&env);

    let split = client.calculate(&merchant, &10_000);
    assert_eq!(split.fee, 250);
    assert_eq!(split.net, 9_750);

    // 333 stroops at 250 bps = 8.325 -> 8, remainder to the merchant.
    let odd = client.calculate(&merchant, &333);
    assert_eq!(odd.fee, 8);
    assert_eq!(odd.net, 325);
    assert_eq!(odd.fee + odd.net, 333);
}

#[test]
fn merchant_override_wins_and_can_be_cleared() {
    let (env, client, admin, _treasury) = setup();
    let merchant = Address::generate(&env);

    client.set_merchant_fee(&admin, &merchant, &Some(100));
    assert_eq!(client.fee_bps_for(&merchant), 100);

    client.set_merchant_fee(&admin, &merchant, &None);
    assert_eq!(client.fee_bps_for(&merchant), 250);
}

#[test]
fn fee_above_cap_is_rejected() {
    let (env, client, admin, _treasury) = setup();
    assert_eq!(
        client.try_set_default_fee(&admin, &(MAX_FEE_BPS + 1)),
        Err(Ok(Error::LimitExceeded))
    );
    assert_eq!(
        client.try_set_merchant_fee(&admin, &Address::generate(&env), &Some(1_001)),
        Err(Ok(Error::LimitExceeded))
    );
}

#[test]
fn zero_amount_cannot_be_split() {
    let (env, client, _admin, _treasury) = setup();
    assert_eq!(
        client.try_calculate(&Address::generate(&env), &0),
        Err(Ok(Error::InvalidInput))
    );
}

#[test]
fn overflow_is_an_error_not_a_trap() {
    let (env, client, _admin, _treasury) = setup();
    let merchant = Address::generate(&env);
    assert_eq!(
        client.try_calculate(&merchant, &i128::MAX),
        Err(Ok(Error::InvalidInput))
    );
}
