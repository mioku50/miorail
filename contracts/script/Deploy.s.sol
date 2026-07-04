// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "../src/MioSpendPermissionController.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        MioSpendPermissionController controller = new MioSpendPermissionController();
        console.log("MioSpendPermissionController deployed to:", address(controller));

        vm.stopBroadcast();
    }
}
