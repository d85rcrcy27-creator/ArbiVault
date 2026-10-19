// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../contracts/ArbiVaultEthereumSepoliaFlashExecutor.sol";

interface Vm {
    function chainId(uint256 newChainId) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function expectRevert(bytes4 revertData) external;
}

contract MockPoolCode {}

contract ArbiVaultEthereumSepoliaFlashExecutorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant AAVE_POOL = 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;
    address private constant UNISWAP_ROUTER = 0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3;
    address private constant SUSHISWAP_ROUTER = 0xeaBcE3E74EF41FB40024a21Cc2ee2F5dDc615791;
    address private constant USDC = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;

    function setUp() public {
        vm.chainId(11155111);
        vm.etch(AAVE_POOL, type(MockPoolCode).runtimeCode);
    }

    function testOnlyAllowlistedRouters() public {
        ArbiVaultEthereumSepoliaFlashExecutor executor = new ArbiVaultEthereumSepoliaFlashExecutor(AAVE_POOL, address(this));
        require(executor.isAllowedRouter(UNISWAP_ROUTER), "Uniswap should be allowed");
        require(executor.isAllowedRouter(SUSHISWAP_ROUTER), "SushiSwap should be allowed");
        require(!executor.isAllowedRouter(address(0xBEEF)), "unknown router must be denied");
    }

    function testRejectsSameRouterForBothLegs() public {
        ArbiVaultEthereumSepoliaFlashExecutor executor = new ArbiVaultEthereumSepoliaFlashExecutor(AAVE_POOL, address(this));
        address[] memory targets = new address[](2);
        targets[0] = UNISWAP_ROUTER;
        targets[1] = UNISWAP_ROUTER;
        uint256[] memory values = new uint256[](2);
        bytes[] memory calls = new bytes[](2);
        calls[0] = hex"12345678";
        calls[1] = hex"12345678";

        vm.expectRevert(ArbiVaultEthereumSepoliaFlashExecutor.InvalidArguments.selector);
        executor.executeFlashLoan(USDC, 1, 1, targets, values, calls);
    }

    function testConstructorRejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(ArbiVaultEthereumSepoliaFlashExecutor.InvalidArguments.selector);
        new ArbiVaultEthereumSepoliaFlashExecutor(AAVE_POOL, address(this));
    }
}
