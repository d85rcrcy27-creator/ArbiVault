// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/ArbiVaultFlashExecutor.sol";

interface Vm {
    function prank(address sender) external;
    function expectRevert(bytes4 revertSelector) external;
}

contract MockToken is IArbiVaultERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 permitted = allowance[from][msg.sender];
        if (permitted != type(uint256).max) {
            require(permitted >= amount, "ALLOWANCE");
            allowance[from][msg.sender] = permitted - amount;
        }
        require(balanceOf[from] >= amount, "BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockRouter is IArbiVaultV2Router {
    uint256 public rateBps;
    constructor(uint256 rateBps_) { rateBps = rateBps_; }
    function setRate(uint256 rateBps_) external { rateBps = rateBps_; }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external override returns (uint256[] memory amounts) {
        require(path.length >= 2, "PATH");
        require(deadline > block.timestamp, "DEADLINE");
        require(MockToken(path[0]).transferFrom(msg.sender, address(this), amountIn), "INPUT");
        uint256 amountOut = amountIn * rateBps / 10_000;
        require(amountOut >= amountOutMin, "SLIPPAGE");
        MockToken(path[path.length - 1]).mint(to, amountOut);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountOut;
    }
}

contract MockAavePool is IArbiVaultAavePool {
    uint256 public premium;
    constructor(uint256 premium_) { premium = premium_; }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external override {
        MockToken(asset).transfer(receiverAddress, amount);
        bool success = IFlashReceiverForTest(receiverAddress).executeOperation(
            asset,
            amount,
            premium,
            msg.sender,
            params
        );
        require(success, "CALLBACK");
        MockToken(asset).transferFrom(receiverAddress, address(this), amount + premium);
    }
}

interface IFlashReceiverForTest {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool);
}

contract ArbiVaultFlashExecutorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant HOT_WALLET = address(0xBEEF);
    address private constant ATTACKER = address(0xBAD);
    uint256 private constant LOAN_AMOUNT = 1_000;
    uint256 private constant PREMIUM = 10;

    MockToken private tokenA;
    MockToken private tokenB;
    MockAavePool private pool;
    MockRouter private routerOne;
    MockRouter private routerTwo;
    ArbiVaultFlashExecutor private executor;

    function setUp() public {
        tokenA = new MockToken();
        tokenB = new MockToken();
        pool = new MockAavePool(PREMIUM);
        routerOne = new MockRouter(11_000); // 1,000 A -> 1,100 B
        routerTwo = new MockRouter(10_020); // 1,100 B -> 1,102 A (integer rounding)

        address[] memory routers = new address[](2);
        routers[0] = address(routerOne);
        routers[1] = address(routerTwo);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);

        executor = new ArbiVaultFlashExecutor(
            address(pool),
            HOT_WALLET,
            address(tokenA),
            routers,
            tokens
        );

        tokenA.mint(address(pool), 1_000_000);
    }

    function testProfitIsPaidToBoundHotWalletAndBaselinePreserved() public {
        tokenA.mint(address(executor), 25);
        uint256 hotBefore = tokenA.balanceOf(HOT_WALLET);

        (address[] memory targets, uint256[] memory values, bytes[] memory calls) = _profitableRoute(address(executor));
        vm.prank(HOT_WALLET);
        executor.executeFlashLoan(address(tokenA), LOAN_AMOUNT, 50, targets, values, calls);

        require(tokenA.balanceOf(HOT_WALLET) - hotBefore == 92, "PAYOUT_AMOUNT");
        require(tokenA.balanceOf(address(executor)) == 25, "BASELINE_NOT_PRESERVED");
        require(tokenA.balanceOf(address(pool)) == 1_000_010, "POOL_NOT_REPAID");
    }

    function testUnauthorizedWalletCannotStartFlashLoan() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calls) = _profitableRoute(address(executor));
        vm.expectRevert(ArbiVaultFlashExecutor.Unauthorized.selector);
        vm.prank(ATTACKER);
        executor.executeFlashLoan(address(tokenA), LOAN_AMOUNT, 50, targets, values, calls);
    }

    function testRouterNotInImmutableAllowlistIsRejected() public {
        MockRouter rogue = new MockRouter(11_000);
        (address[] memory targets, uint256[] memory values, bytes[] memory calls) = _profitableRoute(address(executor));
        targets[0] = address(rogue);

        vm.expectRevert(ArbiVaultFlashExecutor.RouterNotAllowed.selector);
        vm.prank(HOT_WALLET);
        executor.executeFlashLoan(address(tokenA), LOAN_AMOUNT, 50, targets, values, calls);
    }

    function testSwapCannotRedirectOutputAwayFromExecutor() public {
        (address[] memory targets, uint256[] memory values, bytes[] memory calls) = _profitableRoute(address(0xCAFE));
        vm.expectRevert(ArbiVaultFlashExecutor.MisroutedSwap.selector);
        vm.prank(HOT_WALLET);
        executor.executeFlashLoan(address(tokenA), LOAN_AMOUNT, 50, targets, values, calls);
    }

    function testMinimumProfitIsEnforcedBeforePayout() public {
        routerOne.setRate(10_000);
        routerTwo.setRate(10_000);
        (address[] memory targets, uint256[] memory values, bytes[] memory calls) = _profitableRoute(address(executor));

        vm.expectRevert(ArbiVaultFlashExecutor.InsufficientProfit.selector);
        vm.prank(HOT_WALLET);
        executor.executeFlashLoan(address(tokenA), LOAN_AMOUNT, 1, targets, values, calls);

        require(tokenA.balanceOf(HOT_WALLET) == 0, "PAYOUT_ON_FAILED_ROUTE");
    }

    function testBorrowedAssetMustBeFinalAsset() public {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calls = new bytes[](1);
        targets[0] = address(routerOne);
        calls[0] = abi.encodeWithSelector(
            IArbiVaultV2Router.swapExactTokensForTokens.selector,
            LOAN_AMOUNT,
            1,
            _path(address(tokenA), address(tokenB)),
            address(executor),
            block.timestamp + 60
        );

        vm.expectRevert(ArbiVaultFlashExecutor.InvalidFinalAsset.selector);
        vm.prank(HOT_WALLET);
        executor.executeFlashLoan(address(tokenA), LOAN_AMOUNT, 0, targets, values, calls);
    }

    function _profitableRoute(address recipient)
        private
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calls)
    {
        targets = new address[](2);
        values = new uint256[](2);
        calls = new bytes[](2);
        targets[0] = address(routerOne);
        targets[1] = address(routerTwo);
        calls[0] = abi.encodeWithSelector(
            IArbiVaultV2Router.swapExactTokensForTokens.selector,
            LOAN_AMOUNT,
            1_000,
            _path(address(tokenA), address(tokenB)),
            recipient,
            block.timestamp + 60
        );
        calls[1] = abi.encodeWithSelector(
            IArbiVaultV2Router.swapExactTokensForTokens.selector,
            1_100,
            1_100,
            _path(address(tokenB), address(tokenA)),
            recipient,
            block.timestamp + 60
        );
    }

    function _path(address input, address output) private pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = input;
        path[1] = output;
    }
}
