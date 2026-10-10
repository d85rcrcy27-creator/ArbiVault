// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Atomic Aave V3 flash executor for ArbiVault on BNB Smart Chain.
/// @dev One instance per hot wallet. Only that wallet can initiate a loan. Two distinct
///      approved V2 routers and a WBNB/USDT round trip are required.
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

    address public constant PANCAKE_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address public constant BISWAP_ROUTER_V2 = 0x3a6d8ca21d1cf76f653a67577fa0d27453350dd8;
    address public constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address public constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    uint256 private constant MAX_UINT = type(uint256).max;

    error UnauthorizedCaller();
    error InvalidArguments();
    error InvalidInitiator();
    error TargetNotAllowed(address target);
    error CallFailed(uint256 index,bytes reason);
    error ProfitBelowMinimum(uint256 available,uint256 required);
    error TokenOperationFailed();
    error InvalidSwapCall(uint256 index);
    error InvalidRoundTrip();

    constructor(address pool,address hotWallet) {
        if (pool == address(0) || hotWallet == address(0)) revert InvalidArguments();
        POOL = IAaveV3Pool(pool);
        HOT_WALLET = hotWallet;
    }

    function isAllowedRouter(address target) public pure returns (bool) {
        return target == PANCAKE_V2_ROUTER || target == BISWAP_ROUTER_V2;
    }

    function _ensureApproval(IERC20Flash token,address router) private {
        if (token.allowance(address(this),router) < MAX_UINT / 2) {
            if (!token.approve(router,0)) revert TokenOperationFailed();
            if (!token.approve(router,MAX_UINT)) revert TokenOperationFailed();
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

    function executeFlashLoan(address asset,uint256 amount,uint256 minProfit,address[] calldata targets,uint256[] calldata values,bytes[] calldata data) external {
        if (msg.sender != HOT_WALLET) revert UnauthorizedCaller();
        if (
            (asset != WBNB && asset != USDT) || amount == 0 || minProfit == 0 ||
            targets.length != 2 || values.length != 2 || data.length != 2 ||
            targets[0] == targets[1] || !isAllowedRouter(targets[0]) || !isAllowedRouter(targets[1]) ||
            values[0] != 0 || values[1] != 0
        ) revert InvalidArguments();

        preLoanBalance = IERC20Flash(asset).balanceOf(address(this));
        POOL.flashLoanSimple(address(this),asset,amount,abi.encode(minProfit,targets,values,data),0);
        preLoanBalance = 0;
    }

    function executeOperation(address asset,uint256 amount,uint256 premium,address initiator,bytes calldata params) external returns (bool) {
        if (msg.sender != address(POOL)) revert UnauthorizedCaller();
        if (initiator != address(this)) revert InvalidInitiator();
        if ((asset != WBNB && asset != USDT) || amount == 0) revert InvalidArguments();

        (uint256 minProfit,address[] memory targets,uint256[] memory values,bytes[] memory data) =
            abi.decode(params,(uint256,address[],uint256[],bytes[]));
        if (
            targets.length != 2 || values.length != 2 || data.length != 2 ||
            targets[0] == targets[1] || !isAllowedRouter(targets[0]) || !isAllowedRouter(targets[1]) ||
            values[0] != 0 || values[1] != 0
        ) revert InvalidArguments();

        address intermediate = asset == WBNB ? USDT : WBNB;
        uint256 previousOutput;

        _ensureApproval(IERC20Flash(WBNB),PANCAKE_V2_ROUTER);
        _ensureApproval(IERC20Flash(USDT),PANCAKE_V2_ROUTER);
        _ensureApproval(IERC20Flash(WBNB),BISWAP_ROUTER_V2);
        _ensureApproval(IERC20Flash(USDT),BISWAP_ROUTER_V2);

        for (uint256 i; i < 2; ++i) {
            if (!isAllowedRouter(targets[i])) revert TargetNotAllowed(targets[i]);
            (uint256 amountIn,uint256 amountOutMin,address[] memory path,address recipient,uint256 deadline) = _decodeSwap(data[i],i);
            if (
                amountIn == 0 || amountOutMin == 0 || path.length != 2 || recipient != address(this) ||
                deadline <= block.timestamp || deadline > block.timestamp + 120
            ) revert InvalidSwapCall(i);

            if (i == 0) {
                if (path[0] != asset || path[1] != intermediate || amountIn != amount) revert InvalidRoundTrip();
            } else {
                if (path[0] != intermediate || path[1] != asset || amountIn != previousOutput) revert InvalidRoundTrip();
            }

            (bool ok,bytes memory returned) = targets[i].call(data[i]);
            if (!ok) revert CallFailed(i,returned);
            uint256[] memory amounts = abi.decode(returned,(uint256[]));
            if (amounts.length != 2 || amounts[0] != amountIn) revert InvalidSwapCall(i);
            previousOutput = amounts[1];
        }

        uint256 repayment = amount + premium;
        uint256 balance = IERC20Flash(asset).balanceOf(address(this));
        uint256 required = preLoanBalance + repayment + minProfit;
        if (balance < required) revert ProfitBelowMinimum(balance,required);

        uint256 profit = balance - preLoanBalance - repayment;
        if (profit != 0 && !IERC20Flash(asset).transfer(HOT_WALLET,profit)) revert TokenOperationFailed();
        if (!IERC20Flash(asset).approve(address(POOL),repayment)) revert TokenOperationFailed();
        return true;
    }

    receive() external payable { revert UnauthorizedCaller(); }
}
