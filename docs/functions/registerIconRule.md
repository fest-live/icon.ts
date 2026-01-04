[**@fest-lib/icon v0.0.0**](../README.md)

***

[@fest-lib/icon](../README.md) / registerIconRule

# Function: registerIconRule()

```ts
function registerIconRule(
   iconName, 
   iconStyle, 
   imageUrl, 
   bucket): void;
```

Defined in: [loader/CSSIconRegistry.ts:146](https://github.com/fest-live/icon.ts/blob/422782168fe6d2023c032f8a018d0191f594741e/src/loader/CSSIconRegistry.ts#L146)

Registers an icon rule in the stylesheet
Rules are batched and deduplicated automatically

## Parameters

### iconName

`string`

### iconStyle

`string`

### imageUrl

`string`

### bucket

`number` = `MIN_RASTER_SIZE`

## Returns

`void`
