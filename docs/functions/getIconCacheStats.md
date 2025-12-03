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

Defined in: [loader/OPFSCache.ts:332](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/OPFSCache.ts#L332)

Gets cache statistics

## Returns

`Promise`\<
  \| \{
  `rasterCount`: `number`;
  `totalSize`: `number`;
  `vectorCount`: `number`;
\}
  \| `null`\>
