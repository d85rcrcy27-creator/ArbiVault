// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../contracts/ArbiVaultFlashExecutor.sol";

interface Vm {
    function chainId(uint256 newChainId) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function expectRevert(bytes4 revertData) external;
}

contract MockBscPoolCode {}

contract ArbiVaultFlashExecutorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant AAVE_POOL = 0x6807dc923806fE8Fd134338EABCA509979a7e0cB;
    address private constant PROFIT_RECIPIENT = address(0xCAFE);
    address private constant PANCAKE = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address private constant BISWAP = 0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8;
    address private constant USDT = 0x55d398326f99059fF775485246999027B3197955;

    function setUp() public {
        vm.chainId(56);
        vm.etch(AAVE_POOL, type(MockBscPoolCode).runtimeCode);
    }

    function testOnlyAllowlistedRouters() public {
        ArbiVaultFlashExecutor executor = new ArbiVaultFlashExecutor(AAVE_POOL, address(this), address(0xCAFE));
        require(executor.isAllowedRouter(PANCAKE), "PancakeSwap must be allowed");
        require(executor.isAllowedRouter(BISWAP), "BiSwap must be allowed");
        require(!executor.isAllowedRouter(address(0xBEEF)), "unknown router must be denied");
    }

    function testRejectsSameRouterForBothLegs() public {
        ArbiVaultFlashExecutor executor = new ArbiVaultFlashExecutor(AAVE_POOL, address(this), address(0xCAFE));
        address[] memory targets = new address[](2);
        targets[0] = PANCAKE;
        targets[1] = PANCAKE;
        uint256[] memory values = new uint256[](2);
        bytes[] memory calls = new bytes[](2);
        calls[0] = hex"12345678";
        calls[1] = hex"12345678";

        vm.expectRevert(ArbiVaultFlashExecutor.InvalidArguments.selector);
        executor.executeFlashLoan(USDT, 1, 1, targets, values, calls);
    }

    function testConstructorRejectsProfitRecipientEqualToHotWallet() public {
        vm.expectRevert(ArbiVaultFlashExecutor.InvalidArguments.selector);
        new ArbiVaultFlashExecutor(AAVE_POOL, address(this), address(this));
    }

    function testConstructorRejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(ArbiVaultFlashExecutor.InvalidArguments.selector);
        new ArbiVaultFlashExecutor(AAVE_POOL, address(this), address(0xCAFE));
    }
}
