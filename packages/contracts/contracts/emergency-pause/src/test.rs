use super::*;
use merchant_registry::MerchantRegistryClient;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Env;

struct World {
    env: Env,
    pause: EmergencyPauseClient<'static>,
    registry: MerchantRegistryClient<'static>,
    pause_id: Address,
    registry_id: Address,
    admin: Address,
    guardian: Address,
}

fn world() -> World {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);

    let pause_id = env.register(EmergencyPause, ());
    let pause = EmergencyPauseClient::new(&env, &pause_id);
    pause.initialize(&admin);
    pause.grant_role(&admin, &Role::Pauser, &guardian);

    let registry_id = env.register(merchant_registry::MerchantRegistry, ());
    let registry = MerchantRegistryClient::new(&env, &registry_id);
    registry.initialize(&admin);
    registry.set_pause_authority(&admin, &pause_id);

    pause.register_target(&admin, &registry_id);

    World {
        env,
        pause,
        registry,
        pause_id,
        registry_id,
        admin,
        guardian,
    }
}

#[test]
fn pause_all_halts_registered_contracts() {
    let w = world();
    assert!(!w.registry.is_paused());
    assert_eq!(w.pause.pause_all(&w.guardian), 1);
    assert!(w.registry.is_paused());
    assert!(w.pause.is_paused());

    assert_eq!(w.pause.unpause_all(&w.guardian), 1);
    assert!(!w.registry.is_paused());
    assert!(!w.pause.is_paused());
}

#[test]
fn single_target_pause_is_scoped() {
    let w = world();
    w.pause
        .pause_target(&w.guardian, &w.pause.targets().get(0).unwrap());
    assert!(w.registry.is_paused());
    // The aggregate flag only tracks pause_all.
    assert!(!w.pause.is_paused());
}

#[test]
fn non_pauser_cannot_pause() {
    let w = world();
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.pause.try_pause_all(&stranger),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        w.pause.try_unpause_all(&stranger),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn registration_is_admin_only() {
    let w = world();
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.pause.try_register_target(&stranger, &stranger),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        w.pause.try_unregister_target(&stranger, &w.pause_id),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn duplicate_registration_rejected() {
    let w = world();
    assert_eq!(
        w.pause.try_register_target(&w.admin, &w.registry_id),
        Err(Ok(Error::AlreadyExists))
    );
    assert_eq!(w.pause.target_count(), 1);
}

#[test]
fn unregister_removes_target() {
    let w = world();
    w.pause.unregister_target(&w.admin, &w.registry_id);
    assert_eq!(w.pause.target_count(), 0);
    assert_eq!(
        w.pause.try_unregister_target(&w.admin, &w.registry_id),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn unregistered_target_cannot_be_paused_directly() {
    let w = world();
    assert_eq!(
        w.pause
            .try_pause_target(&w.guardian, &Address::generate(&w.env)),
        Err(Ok(Error::NotFound))
    );
}

#[test]
fn misconfigured_target_makes_pause_all_fail_loudly() {
    let w = world();
    // A second registry that has not adopted this pauser: pause_all must fail
    // rather than report success.
    let other_id = w.env.register(merchant_registry::MerchantRegistry, ());
    let other = MerchantRegistryClient::new(&w.env, &other_id);
    other.initialize(&w.admin);
    w.pause.register_target(&w.admin, &other_id);
    assert!(w.pause.try_pause_all(&w.guardian).is_err());
    assert!(!w.pause.is_paused());
}
