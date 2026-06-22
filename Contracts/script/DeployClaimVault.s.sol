// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PerkosClaimVault} from "../src/PerkosClaimVault.sol";

/**
 * Deploy the PerkosClaimVault behind a UUPS proxy.
 *
 *   forge script script/DeployClaimVault.s.sol:DeployClaimVault \
 *     --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_PRIVATE_KEY \
 *     --sig 'run(address,address,address,address)' \
 *     $SAFE_OWNER $USDC $PERKOS $DISTRIBUTOR
 *
 * owner       — Safe multisig (NOT an EOA). Can set roots, withdraw, upgrade.
 * usdc        — USDC token on the target chain (Base USDC 0x8335…2913).
 * perkos      — $PERKOS token on the target chain.
 * distributor — hot key allowed to set roots (use address(0) for owner-only).
 */
contract DeployClaimVault is Script {
    function run(address owner, address usdc, address perkos, address distributor)
        external
        returns (address proxy, address implementation)
    {
        require(owner != address(0), "owner zero");
        require(usdc != address(0), "usdc zero");
        // perkos may be 0 — wired later with setRewardToken (USDC claims work now).

        vm.startBroadcast();

        PerkosClaimVault impl = new PerkosClaimVault();
        implementation = address(impl);

        bytes memory initCalldata = abi.encodeCall(
            PerkosClaimVault.initialize,
            (owner, usdc, perkos, distributor)
        );
        ERC1967Proxy p = new ERC1967Proxy(implementation, initCalldata);
        proxy = address(p);

        vm.stopBroadcast();

        console2.log("PerkosClaimVault implementation:", implementation);
        console2.log("PerkosClaimVault proxy        :", proxy);
        console2.log("Owner / USDC / PERKOS / distributor:");
        console2.log(owner);
        console2.log(usdc);
        console2.log(perkos);
        console2.log(distributor);
        console2.log("Wire this PROXY into the Knowledge claim service.");
    }
}
