// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "../MioSpendPermissionController.sol";

// Historical Base Sepolia experiment only. This file is outside Foundry's
// default script directory and must never be used for a production deploy.
contract DeployLegacyMioSpendPermissionControllerScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        MioSpendPermissionController controller = new MioSpendPermissionController();
        console.log("MioSpendPermissionController deployed to:", address(controller));

        vm.stopBroadcast();
    }
}
