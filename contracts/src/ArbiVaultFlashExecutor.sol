// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Aave V3 Pool interface. The pool address is immutable per deployment.
interface IArbiVaultAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IArbiVaultERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IArbiVaultV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @notice Non-upgradeable Aave V3 flash-loan executor with a fixed ArbiVault hot-wallet payout.
/// @dev Calls only allowlisted V2 routers, only through swapExactTokensForTokens, and only with
///      output returned to this contract. The last leg must return the borrowed asset. All net
///      profit above repayment and the caller-specified minimum is paid to HOT_WALLET atomically.
contract ArbiVaultFlashExecutor {
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidRequest();
    error ReentrantCall();
    error InvalidFlashCallback();
    error RouterNotAllowed();
    error TokenNotAllowed();
    error NativeValueNotAllowed();
    error UnsupportedSwapSelector();
    error InvalidSwapCalldata();
    error NonCanonicalCalldata();
    error MisroutedSwap();
    error InvalidPath();
    error InvalidDeadline();
    error InvalidAmount();
    error SwapInputMismatch();
    error SwapOutputMismatch();
    error InvalidFinalAsset();
    error InsufficientProfit();
    error TokenCallFailed();
    error FlashCallbackMissing();
    error BaselineBalanceChanged();

    bytes4 private constant SWAP_EXACT_TOKENS_FOR_TOKENS = IArbiVaultV2Router.swapExactTokensForTokens.selector;

    address public immutable POOL;
    address public immutable HOT_WALLET;
    address public immutable LOAN_ASSET;

    mapping(address => bool) public isRouterAllowed;
    mapping(address => bool) public isTokenAllowed;

    bool private _active;
    bool private _callbackSeen;

    event FlashLoanSettled(
        address indexed asset,
        uint256 amount,
        uint256 premium,
        uint256 profit,
        address indexed payoutWallet
    );

    constructor(
        address pool,
        address hotWallet,
        address loanAsset,
        address[] memory routers,
        address[] memory tokens
    ) {
        if (
            pool == address(0) || pool.code.length == 0 ||
            hotWallet == address(0) ||
            loanAsset == address(0) || loanAsset.code.length == 0 ||
            routers.length == 0 || tokens.length == 0
        ) revert InvalidConfiguration();

        POOL = pool;
        HOT_WALLET = hotWallet;
        LOAN_ASSET = loanAsset;

        bool loanAssetListed;
        for (uint256 i; i < routers.length; ++i) {
            address router = routers[i];
            if (router == address(0) || router.code.length == 0) revert InvalidConfiguration();
            isRouterAllowed[router] = true;
        }
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            if (token == address(0) || token.code.length == 0) revert InvalidConfiguration();
            isTokenAllowed[token] = true;
            if (token == loanAsset) loanAssetListed = true;
        }
        if (!loanAssetListed) revert InvalidConfiguration();
    }

    /// @notice Starts an atomic flash loan. The only transaction initiator is the bound hot wallet.
    /// @dev targets/values/data are retained for ABI compatibility with the current builder, but
    ///      the callback strictly decodes and re-encodes every swap; arbitrary calls are not made.
    function executeFlashLoan(
        address asset,
        uint256 amount,
        uint256 minProfit,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata data
    ) external {
        if (msg.sender != HOT_WALLET) revert Unauthorized();
        if (_active) revert ReentrantCall();
        if (
            asset != LOAN_ASSET || amount == 0 ||
            targets.length == 0 ||
            targets.length != values.length ||
            targets.length != data.length
        ) revert InvalidRequest();

        uint256 baselineAssetBalance = IArbiVaultERC20(asset).balanceOf(address(this));
        _active = true;
        _callbackSeen = false;

        bytes memory params = abi.encode(minProfit, targets, values, data, baselineAssetBalance);
        IArbiVaultAavePool(POOL).flashLoanSimple(address(this), asset, amount, params, 0);

        if (!_callbackSeen) revert FlashCallbackMissing();
        _active = false;

        // Nothing may leave behind newly-created borrowed-asset dust. Pre-existing balance is preserved.
        if (IArbiVaultERC20(asset).balanceOf(address(this)) != baselineAssetBalance) {
            revert BaselineBalanceChanged();
        }
    }

    /// @notice Aave V3 flash-loan callback. Repayment is approved only after payout validation.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (
            msg.sender != POOL || !_active || _callbackSeen ||
            initiator != address(this) || asset != LOAN_ASSET
        ) revert InvalidFlashCallback();

        _callbackSeen = true;
        (
            uint256 minProfit,
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory data,
            uint256 baselineAssetBalance
        ) = abi.decode(params, (uint256, address[], uint256[], bytes[], uint256));

        if (
            targets.length == 0 ||
            targets.length != values.length ||
            targets.length != data.length
        ) revert InvalidRequest();

        address currentAsset = asset;
        uint256 currentAmount = amount;

        for (uint256 i; i < targets.length; ++i) {
            address router = targets[i];
            if (!isRouterAllowed[router]) revert RouterNotAllowed();
            if (values[i] != 0) revert NativeValueNotAllowed();
            if (data[i].length < 4 + 32 * 5) revert InvalidSwapCalldata();

            bytes4 selector;
            bytes memory encodedCall = data[i];
            assembly {
                selector := mload(add(encodedCall, 32))
            }
            if (selector != SWAP_EXACT_TOKENS_FOR_TOKENS) revert UnsupportedSwapSelector();

            bytes memory args = new bytes(encodedCall.length - 4);
            for (uint256 j = 4; j < encodedCall.length; ++j) {
                args[j - 4] = encodedCall[j];
            }

            (
                uint256 amountIn,
                uint256 amountOutMin,
                address[] memory path,
                address recipient,
                uint256 deadline
            ) = abi.decode(args, (uint256, uint256, address[], address, uint256));

            bytes memory canonicalCall = abi.encodeWithSelector(
                SWAP_EXACT_TOKENS_FOR_TOKENS,
                amountIn,
                amountOutMin,
                path,
                recipient,
                deadline
            );
            if (keccak256(canonicalCall) != keccak256(encodedCall)) revert NonCanonicalCalldata();
            if (recipient != address(this)) revert MisroutedSwap();
            if (path.length < 2 || path[0] != currentAsset || path[path.length - 1] == currentAsset) {
                revert InvalidPath();
            }
            if (amountIn == 0 || amountIn != currentAmount || amountOutMin == 0) revert InvalidAmount();
            if (deadline <= block.timestamp || deadline > block.timestamp + 300) revert InvalidDeadline();

            for (uint256 k; k < path.length; ++k) {
                if (!isTokenAllowed[path[k]]) revert TokenNotAllowed();
            }

            address outputAsset = path[path.length - 1];
            uint256 inputBefore = IArbiVaultERC20(currentAsset).balanceOf(address(this));
            uint256 outputBefore = IArbiVaultERC20(outputAsset).balanceOf(address(this));
            if (inputBefore < amountIn) revert SwapInputMismatch();

            _safeApprove(currentAsset, router, 0);
            _safeApprove(currentAsset, router, amountIn);

            IArbiVaultV2Router(router).swapExactTokensForTokens(
                amountIn,
                amountOutMin,
                path,
                address(this),
                deadline
            );

            _safeApprove(currentAsset, router, 0);

            uint256 inputAfter = IArbiVaultERC20(currentAsset).balanceOf(address(this));
            if (inputAfter > inputBefore || inputBefore - inputAfter != amountIn) {
                revert SwapInputMismatch();
            }

            uint256 outputAfter = IArbiVaultERC20(outputAsset).balanceOf(address(this));
            if (outputAfter < outputBefore) revert SwapOutputMismatch();
            uint256 actualAmountOut = outputAfter - outputBefore;
            if (actualAmountOut < amountOutMin || actualAmountOut == 0) revert SwapOutputMismatch();

            currentAsset = outputAsset;
            currentAmount = actualAmountOut;
        }

        if (currentAsset != asset) revert InvalidFinalAsset();

        uint256 repayment = amount + premium;
        uint256 finalAssetBalance = IArbiVaultERC20(asset).balanceOf(address(this));
        if (finalAssetBalance < baselineAssetBalance + repayment) revert InsufficientProfit();

        uint256 profit = finalAssetBalance - baselineAssetBalance - repayment;
        if (profit < minProfit) revert InsufficientProfit();

        // Payout is immutable and cannot be redirected through the request calldata.
        if (profit > 0) _safeTransfer(asset, HOT_WALLET, profit);

        _safeApprove(asset, POOL, 0);
        _safeApprove(asset, POOL, repayment);

        emit FlashLoanSettled(asset, amount, premium, profit, HOT_WALLET);
        return true;
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(
            abi.encodeWithSelector(IArbiVaultERC20.approve.selector, spender, amount)
        );
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenCallFailed();
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(
            abi.encodeWithSelector(IArbiVaultERC20.transfer.selector, to, amount)
        );
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenCallFailed();
    }

    receive() external payable {
        revert NativeValueNotAllowed();
    }
}
