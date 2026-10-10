// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Atomic Aave V3 flash executor for ArbiVault on BNB Smart Chain.
/// @dev Deploy one instance per ArbiVault trading hot wallet. The network, Aave pool,
///      routers, asset pair, swap direction, recipient, and deadline are all constrained.
interface IAaveV3Pool {
    function flashLoanSimple(address receiverAddress,address asset,uint256 amount,bytes calldata params,uint16 referralCode) external;
}
interface IERC20Flash {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner,address spender) external view returns (uint256);
    function approve(address spender,uint256 amount) external returns (bool);
    function transfer(address recipient,uint256 amount) external returns (bool);
}
interface IV2FlashRouter {
    function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) external returns (uint256[] memory amounts);
}

contract ArbiVaultFlashExecutor {
    address public immutable HOT_WALLET;
    IAaveV3Pool public immutable POOL;
    uint256 private preLoanBalance;
    address private expectedAsset;
    uint256 private expectedAmount;
    bool private loanActive;
    bool private callbackCompleted;

    address public constant AAVE_V3_POOL_BSC = 0x6807dc923806fE8Fd134338EABCA509979a7e0cB;
    address public constant PANCAKE_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address public constant BISWAP_ROUTER_V2 = 0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8;
    address public constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address public constant USDT = 0x55d398326f99059fF775485246999027B3197955;

    error UnauthorizedCaller();
    error InvalidArguments();
    error InvalidInitiator();
    error TargetNotAllowed(address target);
    error CallFailed(uint256 index,bytes reason);
    error ProfitBelowMinimum(uint256 available,uint256 required);
    error TokenOperationFailed();
    error InvalidSwapCall(uint256 index);
    error InvalidRoundTrip();
    error CallbackNotCompleted();
    error LoanStateMismatch();

    event FlashLoanStarted(address indexed asset,uint256 amount,address indexed hotWallet);
    event FlashLoanSettled(address indexed asset,uint256 amount,uint256 premium,uint256 profitPaid,address indexed hotWallet);
    event FlashLoanCompleted(address indexed asset,uint256 amount);

    constructor(address pool,address hotWallet) {
        if (
            block.chainid != 56 ||
            pool != AAVE_V3_POOL_BSC ||
            pool.code.length == 0 ||
            hotWallet == address(0)
        ) revert InvalidArguments();
        POOL = IAaveV3Pool(pool);
        HOT_WALLET = hotWallet;
    }

    function isAllowedRouter(address target) public pure returns (bool) {
        return target == PANCAKE_V2_ROUTER || target == BISWAP_ROUTER_V2;
    }

    /// @dev Set approvals to the precise amount consumed by a single call.
    ///      Clear first because USDT-compatible tokens can require zero-reset approvals.
    function _setExactApproval(IERC20Flash token,address spender,uint256 amount) private {
        uint256 current = token.allowance(address(this),spender);
        if (current != 0 && !token.approve(spender,0)) revert TokenOperationFailed();
        if (amount != 0 && !token.approve(spender,amount)) revert TokenOperationFailed();
    }

    function _clearApproval(IERC20Flash token,address spender) private {
        if (token.allowance(address(this),spender) != 0 && !token.approve(spender,0)) {
            revert TokenOperationFailed();
        }
    }

    function _decodeSwap(bytes memory raw,uint256 index)
        private
        pure
        returns (uint256 amountIn,uint256 amountOutMin,address[] memory path,address recipient,uint256 deadline)
    {
        if (raw.length < 4) revert InvalidSwapCall(index);
        bytes4 selector;
        assembly { selector := mload(add(raw,32)) }
        if (selector != IV2FlashRouter.swapExactTokensForTokens.selector) revert InvalidSwapCall(index);
        bytes memory args = new bytes(raw.length - 4);
        for (uint256 j; j < args.length; ++j) args[j] = raw[j + 4];
        (amountIn,amountOutMin,path,recipient,deadline) =
            abi.decode(args,(uint256,uint256,address[],address,uint256));
    }

    function executeFlashLoan(
        address asset,
        uint256 amount,
        uint256 minProfit,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata data
    ) external {
        if (msg.sender != HOT_WALLET) revert UnauthorizedCaller();
        if (
            loanActive ||
            (asset != WBNB && asset != USDT) ||
            amount == 0 ||
            minProfit == 0 ||
            targets.length != 2 ||
            values.length != 2 ||
            data.length != 2 ||
            targets[0] == targets[1] ||
            !isAllowedRouter(targets[0]) ||
            !isAllowedRouter(targets[1]) ||
            values[0] != 0 ||
            values[1] != 0
        ) revert InvalidArguments();

        loanActive = true;
        callbackCompleted = false;
        expectedAsset = asset;
        expectedAmount = amount;
        preLoanBalance = IERC20Flash(asset).balanceOf(address(this));

        emit FlashLoanStarted(asset,amount,HOT_WALLET);
        POOL.flashLoanSimple(address(this),asset,amount,abi.encode(minProfit,targets,values,data),0);

        if (!callbackCompleted) revert CallbackNotCompleted();
        _clearApproval(IERC20Flash(asset),address(POOL));
        if (IERC20Flash(asset).balanceOf(address(this)) < preLoanBalance) revert LoanStateMismatch();

        loanActive = false;
        callbackCompleted = false;
        expectedAsset = address(0);
        expectedAmount = 0;
        preLoanBalance = 0;
        emit FlashLoanCompleted(asset,amount);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(POOL)) revert UnauthorizedCaller();
        if (initiator != address(this)) revert InvalidInitiator();
        if (
            !loanActive ||
            callbackCompleted ||
            asset != expectedAsset ||
            amount != expectedAmount ||
            (asset != WBNB && asset != USDT) ||
            amount == 0
        ) revert LoanStateMismatch();

        (uint256 minProfit,address[] memory targets,uint256[] memory values,bytes[] memory data) =
            abi.decode(params,(uint256,address[],uint256[],bytes[]));
        if (
            minProfit == 0 ||
            targets.length != 2 ||
            values.length != 2 ||
            data.length != 2 ||
            targets[0] == targets[1] ||
            !isAllowedRouter(targets[0]) ||
            !isAllowedRouter(targets[1]) ||
            values[0] != 0 ||
            values[1] != 0
        ) revert InvalidArguments();

        address intermediate = asset == WBNB ? USDT : WBNB;
        uint256 previousOutput;

        for (uint256 i; i < 2; ++i) {
            (uint256 amountIn,uint256 amountOutMin,address[] memory path,address recipient,uint256 deadline) =
                _decodeSwap(data[i],i);
            if (
                amountIn == 0 ||
                amountOutMin == 0 ||
                path.length != 2 ||
                recipient != address(this) ||
                deadline <= block.timestamp ||
                deadline > block.timestamp + 120
            ) revert InvalidSwapCall(i);

            if (i == 0) {
                if (path[0] != asset || path[1] != intermediate || amountIn != amount) {
                    revert InvalidRoundTrip();
                }
            } else {
                if (path[0] != intermediate || path[1] != asset || amountIn != previousOutput) {
                    revert InvalidRoundTrip();
                }
            }

            IERC20Flash inputToken = IERC20Flash(path[0]);
            _setExactApproval(inputToken,targets[i],amountIn);
            (bool ok,bytes memory returned) = targets[i].call(data[i]);
            if (!ok) revert CallFailed(i,returned);
            uint256[] memory amounts = abi.decode(returned,(uint256[]));
            if (amounts.length != 2 || amounts[0] != amountIn || amounts[1] < amountOutMin) {
                revert InvalidSwapCall(i);
            }
            _clearApproval(inputToken,targets[i]);
            previousOutput = amounts[1];
        }

        uint256 repayment = amount + premium;
        uint256 balance = IERC20Flash(asset).balanceOf(address(this));
        uint256 required = preLoanBalance + repayment + minProfit;
        if (balance < required) revert ProfitBelowMinimum(balance,required);

        uint256 profit = balance - preLoanBalance - repayment;
        if (profit != 0 && !IERC20Flash(asset).transfer(HOT_WALLET,profit)) {
            revert TokenOperationFailed();
        }
        _setExactApproval(IERC20Flash(asset),address(POOL),repayment);
        callbackCompleted = true;
        emit FlashLoanSettled(asset,amount,premium,profit,HOT_WALLET);
        return true;
    }

    receive() external payable {
        revert UnauthorizedCaller();
    }
}
