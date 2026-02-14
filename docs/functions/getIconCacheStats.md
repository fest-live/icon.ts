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

Defined in: [loader/OPFSCache.ts:353](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/OPFSCache.ts#L353)

Gets cache statistics

## Returns

`Promise`\<
  \| \{
  `rasterCount`: `number`;
  `totalSize`: `number`;
  `vectorCount`: `number`;
\}
  \| `null`\>
