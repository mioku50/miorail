// Canonical non-proxy BlueBundlesV1 ABI, verified Sourcify Base deployment
// 0x4d28d900e381ece4b351302f1abe588496793a2b, source checked 2026-10-28.
// Only supply/borrow is included; no caller-provided calldata or reallocations.
export const nativeMorphoBorrowAbiV1 = [
  {
    "name": "blueBundlesV1SupplyCollateralAndBorrow",
    "type": "function",
    "inputs": [
      {
        "name": "marketParams",
        "type": "tuple",
        "components": [
          {
            "name": "loanToken",
            "type": "address"
          },
          {
            "name": "collateralToken",
            "type": "address"
          },
          {
            "name": "oracle",
            "type": "address"
          },
          {
            "name": "irm",
            "type": "address"
          },
          {
            "name": "lltv",
            "type": "uint256"
          }
        ]
      },
      {
        "name": "collateralAssets",
        "type": "uint256"
      },
      {
        "name": "borrowAssets",
        "type": "uint256"
      },
      {
        "name": "maxLtv",
        "type": "uint256"
      },
      {
        "name": "collateralPermit",
        "type": "tuple",
        "components": [
          {
            "name": "kind",
            "type": "uint8"
          },
          {
            "name": "data",
            "type": "bytes"
          }
        ]
      },
      {
        "name": "signedAuthorization",
        "type": "tuple",
        "components": [
          {
            "name": "signature",
            "type": "tuple",
            "components": [
              {
                "name": "v",
                "type": "uint8"
              },
              {
                "name": "r",
                "type": "bytes32"
              },
              {
                "name": "s",
                "type": "bytes32"
              }
            ]
          },
          {
            "name": "nonce",
            "type": "uint256"
          },
          {
            "name": "deadline",
            "type": "uint256"
          }
        ]
      },
      {
        "name": "reallocations",
        "type": "tuple[]",
        "components": [
          {
            "name": "vault",
            "type": "address"
          },
          {
            "name": "adapter",
            "type": "address"
          },
          {
            "name": "marketParams",
            "type": "tuple",
            "components": [
              {
                "name": "loanToken",
                "type": "address"
              },
              {
                "name": "collateralToken",
                "type": "address"
              },
              {
                "name": "oracle",
                "type": "address"
              },
              {
                "name": "irm",
                "type": "address"
              },
              {
                "name": "lltv",
                "type": "uint256"
              }
            ]
          },
          {
            "name": "fromIdle",
            "type": "bool"
          },
          {
            "name": "sourceAdapter",
            "type": "address"
          },
          {
            "name": "sourceMarketParams",
            "type": "tuple",
            "components": [
              {
                "name": "loanToken",
                "type": "address"
              },
              {
                "name": "collateralToken",
                "type": "address"
              },
              {
                "name": "oracle",
                "type": "address"
              },
              {
                "name": "irm",
                "type": "address"
              },
              {
                "name": "lltv",
                "type": "uint256"
              }
            ]
          },
          {
            "name": "assets",
            "type": "uint128"
          },
          {
            "name": "penalty",
            "type": "uint64"
          }
        ]
      },
      {
        "name": "referralFeePct",
        "type": "uint256"
      },
      {
        "name": "referralFeeRecipient",
        "type": "address"
      },
      {
        "name": "deadline",
        "type": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  }
] as const;
