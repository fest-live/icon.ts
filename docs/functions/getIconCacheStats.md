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

Defined in: [loader/OPFSCache.ts:332](https://github.com/fest-live/icon.ts/blob/ddbe67f0182bf092b3f13354155ed37ddbdff151/src/loader/OPFSCache.ts#L332)

Gets cache statistics

## Returns

`Promise`\<
  \| \{
  `rasterCount`: `number`;
  `totalSize`: `number`;
  `vectorCount`: `number`;
\}
  \| `null`\>
