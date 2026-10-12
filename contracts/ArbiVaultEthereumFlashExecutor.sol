// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAaveV3PoolEth {
    function flashLoanSimple(address receiverAddress,address asset,uint256 amount,bytes calldata params,uint16 referralCode) external;
}
interface IERC20FlashEth {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner,address spender) external view returns (uint256);
    function approve(address spender,uint256 amount) external returns (bool);
    function transfer(address recipient,uint256 amount) external returns (bool);
}
interface IUniswapV2FlashRouter {
    function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) external returns (uint256[] memory amounts);
}

/// @notice Ethereum mainnet Aave V3 flash executor using Uniswap V2 WETH/USDC round trips.
/// @dev Deploy one instance per ArbiVault trading hot wallet. Chain, pool, router,
///      assets, recipients, paths, deadlines, repayment and minimum profit are constrained.
contract ArbiVaultEthereumFlashExecutor {
    address public immutable HOT_WALLET;
    IAaveV3PoolEth public immutable POOL;
    uint256 private preLoanBalance;
    address private expectedAsset;
    uint256 private expectedAmount;
    bool private loanActive;
    bool private callbackCompleted;

    address public constant AAVE_V3_POOL_ETH = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address public constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address public constant SUSHISWAP_V2_ROUTER = 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F;
    address public constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address public constant USDC = 0xA0b86991c6218b36c1d19d4a2e9Eb0cE3606eB48;

    error UnauthorizedCaller();
    error InvalidArguments();
    error InvalidInitiator();
    error CallFailed(bytes reason);
    error ProfitBelowMinimum(uint256 available,uint256 required);
    error TokenOperationFailed();
    error InvalidSwapCall();
    error InvalidRoundTrip();
    error CallbackNotCompleted();
    error LoanStateMismatch();

    event FlashLoanStarted(address indexed asset,uint256 amount,address indexed hotWallet);
    event FlashLoanSettled(address indexed asset,uint256 amount,uint256 premium,uint256 profitPaid,address indexed hotWallet);

    function isAllowedRouter(address target) public pure returns (bool) {
        return target == UNISWAP_V2_ROUTER || target == SUSHISWAP_V2_ROUTER;
    }

    constructor(address pool,address hotWallet) {
        if (block.chainid != 1 || pool != AAVE_V3_POOL_ETH || pool.code.length == 0 || hotWallet == address(0)) {
            revert InvalidArguments();
        }
        POOL = IAaveV3PoolEth(pool);
        HOT_WALLET = hotWallet;
    }

    function _approveExact(IERC20FlashEth token,address spender,uint256 amount) private {
        uint256 current = token.allowance(address(this),spender);
        if (current != 0 && !token.approve(spender,0)) revert TokenOperationFailed();
        if (amount != 0 && !token.approve(spender,amount)) revert TokenOperationFailed();
    }

    function _clearApproval(IERC20FlashEth token,address spender) private {
        if (token.allowance(address(this),spender) != 0 && !token.approve(spender,0)) revert TokenOperationFailed();
    }

    function _decodeSwap(bytes memory raw) private pure returns (
        uint256 amountIn,uint256 amountOutMin,address[] memory path,address recipient,uint256 deadline
    ) {
        if (raw.length < 4) revert InvalidSwapCall();
        bytes4 selector;
        assembly { selector := mload(add(raw,32)) }
        if (selector != IUniswapV2FlashRouter.swapExactTokensForTokens.selector) revert InvalidSwapCall();
        bytes memory args = new bytes(raw.length - 4);
        for (uint256 i; i < args.length; ++i) args[i] = raw[i + 4];
        (amountIn,amountOutMin,path,recipient,deadline) =
            abi.decode(args,(uint256,uint256,address[],address,uint256));
    }

    function executeFlashLoan(
        address asset,uint256 amount,uint256 minProfit,address[] calldata targets,
        uint256[] calldata values,bytes[] calldata data
    ) external {
        if (msg.sender != HOT_WALLET) revert UnauthorizedCaller();
        if (loanActive || (asset != WETH && asset != USDC) || amount == 0 || minProfit == 0 ||
            targets.length != 2 || values.length != 2 || data.length != 2 ||
            targets[0] == targets[1] || !isAllowedRouter(targets[0]) || !isAllowedRouter(targets[1]) ||
            values[0] != 0 || values[1] != 0) revert InvalidArguments();

        loanActive = true;
        callbackCompleted = false;
        expectedAsset = asset;
        expectedAmount = amount;
        preLoanBalance = IERC20FlashEth(asset).balanceOf(address(this));
        emit FlashLoanStarted(asset,amount,HOT_WALLET);
        POOL.flashLoanSimple(address(this),asset,amount,abi.encode(minProfit,targets,values,data),0);
        if (!callbackCompleted) revert CallbackNotCompleted();
        _clearApproval(IERC20FlashEth(asset),address(POOL));
        if (IERC20FlashEth(asset).balanceOf(address(this)) < preLoanBalance) revert LoanStateMismatch();
        loanActive = false;
        callbackCompleted = false;
        expectedAsset = address(0);
        expectedAmount = 0;
        preLoanBalance = 0;
    }

    function executeOperation(
        address asset,uint256 amount,uint256 premium,address initiator,bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(POOL)) revert UnauthorizedCaller();
        if (initiator != address(this)) revert InvalidInitiator();
        if (!loanActive || callbackCompleted || asset != expectedAsset || amount != expectedAmount ||
            (asset != WETH && asset != USDC) || amount == 0) revert LoanStateMismatch();

        (uint256 minProfit,address[] memory targets,uint256[] memory values,bytes[] memory data) =
            abi.decode(params,(uint256,address[],uint256[],bytes[]));
        if (minProfit == 0 || targets.length != 2 || values.length != 2 || data.length != 2 ||
            targets[0] == targets[1] || !isAllowedRouter(targets[0]) || !isAllowedRouter(targets[1]) ||
            values[0] != 0 || values[1] != 0) revert InvalidArguments();

        address intermediate = asset == WETH ? USDC : WETH;
        uint256 previousOutput;
        for (uint256 i; i < 2; ++i) {
            (uint256 amountIn,uint256 amountOutMin,address[] memory path,address recipient,uint256 deadline) =
                _decodeSwap(data[i]);
            if (amountIn == 0 || amountOutMin == 0 || path.length != 2 ||
                recipient != address(this) || deadline <= block.timestamp || deadline > block.timestamp + 120) {
                revert InvalidSwapCall();
            }
            if (i == 0) {
                if (path[0] != asset || path[1] != intermediate || amountIn != amount) revert InvalidRoundTrip();
            } else if (path[0] != intermediate || path[1] != asset || amountIn != previousOutput) {
                revert InvalidRoundTrip();
            }

            IERC20FlashEth token = IERC20FlashEth(path[0]);
            _approveExact(token,targets[i],amountIn);
            (bool ok,bytes memory returned) = targets[i].call(data[i]);
            if (!ok) revert CallFailed(returned);
            uint256[] memory amounts = abi.decode(returned,(uint256[]));
            if (amounts.length != 2 || amounts[0] != amountIn || amounts[1] < amountOutMin) revert InvalidSwapCall();
            _clearApproval(token,targets[i]);
            previousOutput = amounts[1];
        }

        uint256 repayment = amount + premium;
        uint256 balance = IERC20FlashEth(asset).balanceOf(address(this));
        uint256 required = preLoanBalance + repayment + minProfit;
        if (balance < required) revert ProfitBelowMinimum(balance,required);
        uint256 profit = balance - preLoanBalance - repayment;
        if (profit != 0 && !IERC20FlashEth(asset).transfer(HOT_WALLET,profit)) revert TokenOperationFailed();
        _approveExact(IERC20FlashEth(asset),address(POOL),repayment);
        callbackCompleted = true;
        emit FlashLoanSettled(asset,amount,premium,profit,HOT_WALLET);
        return true;
    }

    receive() external payable { revert UnauthorizedCaller(); }
}
