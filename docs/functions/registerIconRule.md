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

Defined in: [loader/CSSIconRegistry.ts:145](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/CSSIconRegistry.ts#L145)

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
