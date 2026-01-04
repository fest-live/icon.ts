[**@fest-lib/icon v0.0.0**](../README.md)

***

[@fest-lib/icon](../README.md) / getIconCacheStats

# Function: getIconCacheStats()

```ts
function getIconCacheStats(): Promise<
  | {
  rasterCount: number;
  totalSize: number;
  vectorCount: number;
}
| null>;
```

Defined in: [loader/OPFSCache.ts:332](https://github.com/fest-live/icon.ts/blob/422782168fe6d2023c032f8a018d0191f594741e/src/loader/OPFSCache.ts#L332)

Gets cache statistics

## Returns

`Promise`\<
  \| \{
  `rasterCount`: `number`;
  `totalSize`: `number`;
  `vectorCount`: `number`;
\}
  \| `null`\>
