// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {PerkosClaimVault} from "../src/PerkosClaimVault.sol";

/// Minimal mintable ERC20 for tests.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

contract PerkosClaimVaultTest is Test {
    PerkosClaimVault vault;
    MockERC20 usdc;
    MockERC20 perkos;

    address owner = address(0xA11CE);
    address distributor = address(0xD15);
    address alice = address(0xa1);
    address bob = address(0xb0b);

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        perkos = new MockERC20("PerkOS", "PERKOS", 18);

        PerkosClaimVault impl = new PerkosClaimVault();
        bytes memory initData = abi.encodeCall(
            PerkosClaimVault.initialize,
            (owner, address(usdc), address(perkos), distributor)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vault = PerkosClaimVault(address(proxy));

        // Fund the vault generously.
        usdc.mint(address(vault), 1_000_000);
        perkos.mint(address(vault), 1_000_000 ether);
    }

    // --- merkle helpers (mirror @openzeppelin/merkle-tree StandardMerkleTree) ---

    function _leaf(address acct, uint256 cu, uint256 cr) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(acct, cu, cr))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// Build a 2-leaf tree; return root + each leaf's single-sibling proof.
    function _tree2(bytes32 la, bytes32 lb)
        internal
        pure
        returns (bytes32 root, bytes32[] memory proofA, bytes32[] memory proofB)
    {
        root = _hashPair(la, lb);
        proofA = new bytes32[](1);
        proofA[0] = lb;
        proofB = new bytes32[](1);
        proofB[0] = la;
    }

    function _setRoot2(uint256 aU, uint256 aR, uint256 bU, uint256 bR)
        internal
        returns (bytes32[] memory proofA)
    {
        bytes32 la = _leaf(alice, aU, aR);
        bytes32 lb = _leaf(bob, bU, bR);
        (bytes32 root, bytes32[] memory pa,) = _tree2(la, lb);
        vm.prank(owner);
        vault.setMerkleRoot(root);
        return pa;
    }

    // --- tests ---

    function test_ClaimBothAssets() public {
        bytes32[] memory proofA = _setRoot2(100, 50 ether, 0, 0);
        vault.claim(alice, 100, 50 ether, proofA);
        assertEq(usdc.balanceOf(alice), 100);
        assertEq(perkos.balanceOf(alice), 50 ether);
        assertEq(vault.claimedUsdc(alice), 100);
        assertEq(vault.claimedReward(alice), 50 ether);
    }

    function test_CumulativeDelta() public {
        bytes32[] memory p1 = _setRoot2(100, 50 ether, 0, 0);
        vault.claim(alice, 100, 50 ether, p1);

        // New epoch: alice's cumulative grows; she withdraws only the delta.
        bytes32[] memory p2 = _setRoot2(150, 80 ether, 0, 0);
        vault.claim(alice, 150, 80 ether, p2);

        assertEq(usdc.balanceOf(alice), 150);
        assertEq(perkos.balanceOf(alice), 80 ether);
        assertEq(vault.claimedUsdc(alice), 150);
        assertEq(vault.claimedReward(alice), 80 ether);
    }

    function test_DoubleClaimSameRoot_reverts() public {
        bytes32[] memory proofA = _setRoot2(100, 50 ether, 0, 0);
        vault.claim(alice, 100, 50 ether, proofA);
        vm.expectRevert(PerkosClaimVault.NothingToClaim.selector);
        vault.claim(alice, 100, 50 ether, proofA);
    }

    function test_InvalidProof_reverts() public {
        bytes32[] memory proofA = _setRoot2(100, 50 ether, 0, 0);
        // Tampered cumulative amount → leaf not in root.
        vm.expectRevert(PerkosClaimVault.InvalidProof.selector);
        vault.claim(alice, 999, 50 ether, proofA);
    }

    function test_OnlyOwnerOrDistributor_setRoot() public {
        vm.prank(alice);
        vm.expectRevert(PerkosClaimVault.NotAuthorized.selector);
        vault.setMerkleRoot(bytes32(uint256(1)));

        // distributor may set
        vm.prank(distributor);
        vault.setMerkleRoot(bytes32(uint256(1)));
        assertEq(vault.epoch(), 1);
    }

    function test_setDistributor_ownerOnly() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setDistributor(alice);

        vm.prank(owner);
        vault.setDistributor(address(0)); // owner-only mode
        vm.prank(distributor);
        vm.expectRevert(PerkosClaimVault.NotAuthorized.selector);
        vault.setMerkleRoot(bytes32(uint256(2)));
    }

    function test_pause_blocks_claim() public {
        bytes32[] memory proofA = _setRoot2(100, 50 ether, 0, 0);
        vm.prank(owner);
        vault.pause();
        vm.expectRevert();
        vault.claim(alice, 100, 50 ether, proofA);
    }

    function test_ownerWithdraw() public {
        vm.prank(owner);
        vault.ownerWithdraw(address(usdc), owner, 1000);
        assertEq(usdc.balanceOf(owner), 1000);
    }

    function test_claimableDelta_view() public {
        _setRoot2(100, 50 ether, 0, 0);
        (uint256 u, uint256 r) = vault.claimableDelta(alice, 100, 50 ether);
        assertEq(u, 100);
        assertEq(r, 50 ether);
    }
}
