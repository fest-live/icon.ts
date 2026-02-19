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

Defined in: [loader/CSSIconRegistry.ts:407](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/CSSIconRegistry.ts#L407)

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
