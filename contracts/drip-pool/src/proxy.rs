#![no_std]

//! Transparent proxy contract for vault logic upgrades.
//! Stores the logic contract hash in proxy storage and provides
//! an admin function to upgrade the implementation.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Vec,
};

// ── Storage keys ────────────────────────────────────────────────────────────
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,           // current proxy admin
    LogicContract,   // Address of the current logic contract
}

// ── Errors ───────────────────────────────────────────────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidAddress = 4,
}

// ── Contract ────────────────────────────────────────────────────────────────
#[contract]
pub struct VaultProxy;

#[contractimpl]
impl VaultProxy {
    /// Initialize the proxy with an admin and initial logic contract.
    pub fn create(env: Env, admin: Address, logic_contract: Address) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::LogicContract, &logic_contract);
        env.events().publish(
            (symbol_short!("proxy"), symbol_short!("created")),
            (admin, logic_contract),
        );
        Ok(())
    }

    /// Upgrade the logic contract address. Only callable by the stored admin.
    pub fn upgrade(env: Env, caller: Address, new_logic: Address) -> Result<(), Error> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        if admin != caller {
            return Err(Error::Unauthorized);
        }

        if new_logic == env.current_contract_address() {
            return Err(Error::InvalidAddress);
        }

        env.storage().instance().set(&DataKey::LogicContract, &new_logic);
        env.events().publish(
            (symbol_short!("proxy"), symbol_short!("upgraded")),
            new_logic,
        );
        Ok(())
    }

    /// Get the current logic contract address.
    pub fn logic_contract(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::LogicContract)
            .ok_or(Error::NotInitialized)
    }

    /// Get the proxy admin.
    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }
}