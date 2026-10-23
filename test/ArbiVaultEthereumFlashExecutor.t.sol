// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../contracts/ArbiVaultEthereumFlashExecutor.sol";

interface Vm {
    function chainId(uint256 newChainId) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function expectRevert(bytes4 revertData) external;
}

contract MockPoolCode {}

contract ArbiVaultEthereumFlashExecutorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address private constant PROFIT_RECIPIENT = address(0xCAFE);
    address private constant UNISWAP_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address private constant SUSHISWAP_ROUTER = 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F;
    address private constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    function setUp() public {
        vm.chainId(1);
        vm.etch(AAVE_POOL, type(MockPoolCode).runtimeCode);
    }

    function testOnlyAllowlistedRouters() public {
        ArbiVaultEthereumFlashExecutor executor = new ArbiVaultEthereumFlashExecutor(AAVE_POOL, address(this), address(0xCAFE));
        require(executor.HOT_WALLET() == address(this), "trading wallet getter mismatch");
        require(executor.PROFIT_RECIPIENT() == PROFIT_RECIPIENT, "profit recipient getter mismatch");
        require(address(executor.POOL()) == AAVE_POOL, "pool getter mismatch");
        require(executor.isAllowedRouter(UNISWAP_ROUTER), "Uniswap should be allowed");
        require(executor.isAllowedRouter(SUSHISWAP_ROUTER), "SushiSwap should be allowed");
        require(!executor.isAllowedRouter(address(0xBEEF)), "unknown router must be denied");
    }

    function testRejectsSameRouterForBothLegs() public {
        ArbiVaultEthereumFlashExecutor executor = new ArbiVaultEthereumFlashExecutor(AAVE_POOL, address(this), address(0xCAFE));
        address[] memory targets = new address[](2);
        targets[0] = UNISWAP_ROUTER;
        targets[1] = UNISWAP_ROUTER;
        uint256[] memory values = new uint256[](2);
        bytes[] memory calls = new bytes[](2);
        calls[0] = hex"12345678";
        calls[1] = hex"12345678";

        vm.expectRevert(ArbiVaultEthereumFlashExecutor.InvalidArguments.selector);
        executor.executeFlashLoan(USDC, 1, 1, targets, values, calls);
    }

    function testConstructorRejectsProfitRecipientEqualToHotWallet() public {
        vm.expectRevert(ArbiVaultEthereumFlashExecutor.InvalidArguments.selector);
        new ArbiVaultEthereumFlashExecutor(AAVE_POOL, address(this), address(this));
    }

    function testConstructorRejectsWrongChain() public {
        vm.chainId(56);
        vm.expectRevert(ArbiVaultEthereumFlashExecutor.InvalidArguments.selector);
        new ArbiVaultEthereumFlashExecutor(AAVE_POOL, address(this), address(0xCAFE));
    }
}
