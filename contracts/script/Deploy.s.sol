// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {PayoutExecutor} from "../src/PayoutExecutor.sol";
import {TestToken} from "../src/TestToken.sol";

/// Deploys the executor and the labelled TEST TOKEN, allowlists the token and
/// mints demo balance to the payout wallet.
///
/// Env: PAYOUT_WALLET (address that will pay), MINT_AMOUNT (base units, default 10_000e6).
contract Deploy is Script {
    function run() external returns (PayoutExecutor executor, TestToken token) {
        address payoutWallet = vm.envAddress("PAYOUT_WALLET");
        uint256 mintAmount = vm.envOr("MINT_AMOUNT", uint256(10_000e6));

        vm.startBroadcast();
        executor = new PayoutExecutor(msg.sender);
        token = new TestToken(msg.sender);
        executor.setTokenAllowlisted(address(token), true);
        token.mint(payoutWallet, mintAmount);
        vm.stopBroadcast();

        console2.log("chainId", block.chainid);
        console2.log("PayoutExecutor", address(executor));
        console2.log("TestToken", address(token));
        console2.log("executor codehash");
        console2.logBytes32(address(executor).codehash);
    }
}
