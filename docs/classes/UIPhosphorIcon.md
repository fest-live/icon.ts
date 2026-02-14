[**@fest-lib/icon v0.0.0**](../README.md)

***

[@fest-lib/icon](../README.md) / UIPhosphorIcon

# Class: UIPhosphorIcon

Defined in: [loader/Phosphor.ts:42](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L42)

## Extends

- `HTMLElement`

## Constructors

### Constructor

```ts
new UIPhosphorIcon(options): UIPhosphorIcon;
```

Defined in: [loader/Phosphor.ts:66](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L66)

#### Parameters

##### options

`Partial`\<\{
  `icon`: `string`;
  `iconStyle`: `string`;
  `padding`: `number` \| `string`;
\}\> = `{}`

#### Returns

`UIPhosphorIcon`

#### Overrides

```ts
HTMLElement.constructor
```

## Accessors

### icon

#### Get Signature

```ts
get icon(): string;
```

Defined in: [loader/Phosphor.ts:83](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L83)

##### Returns

`string`

#### Set Signature

```ts
set icon(value): void;
```

Defined in: [loader/Phosphor.ts:87](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L87)

##### Parameters

###### value

`string`

##### Returns

`void`

***

### iconBase

#### Get Signature

```ts
get iconBase(): string;
```

Defined in: [loader/Phosphor.ts:148](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L148)

Optional base URL for same-origin icon hosting.
Example: icon-base="/assets/phosphor"
Will be tried before CDNs.

##### Returns

`string`

#### Set Signature

```ts
set iconBase(value): void;
```

Defined in: [loader/Phosphor.ts:152](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L152)

##### Parameters

###### value

`string`

##### Returns

`void`

***

### iconStyle

#### Get Signature

```ts
get iconStyle(): string;
```

Defined in: [loader/Phosphor.ts:98](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L98)

##### Returns

`string`

#### Set Signature

```ts
set iconStyle(value): void;
```

Defined in: [loader/Phosphor.ts:102](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L102)

##### Parameters

###### value

`string`

##### Returns

`void`

***

### size

#### Get Signature

```ts
get size(): string | null;
```

Defined in: [loader/Phosphor.ts:113](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L113)

##### Returns

`string` \| `null`

#### Set Signature

```ts
set size(value): void;
```

Defined in: [loader/Phosphor.ts:117](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L117)

##### Parameters

###### value

`string` | `null`

##### Returns

`void`

***

### width

#### Get Signature

```ts
get width(): string | null;
```

Defined in: [loader/Phosphor.ts:128](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L128)

##### Returns

`string` \| `null`

#### Set Signature

```ts
set width(value): void;
```

Defined in: [loader/Phosphor.ts:132](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L132)

##### Parameters

###### value

`string` | `number` | `null`

##### Returns

`void`

***

### observedAttributes

#### Get Signature

```ts
get static observedAttributes(): string[];
```

Defined in: [loader/Phosphor.ts:43](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L43)

##### Returns

`string`[]

## Methods

### attributeChangedCallback()

```ts
attributeChangedCallback(
   name, 
   oldValue, 
   newValue): void;
```

Defined in: [loader/Phosphor.ts:204](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L204)

#### Parameters

##### name

`string`

##### oldValue

`string` | `null`

##### newValue

`string` | `null`

#### Returns

`void`

***

### connectedCallback()

```ts
connectedCallback(): void;
```

Defined in: [loader/Phosphor.ts:163](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L163)

#### Returns

`void`

***

### disconnectedCallback()

```ts
disconnectedCallback(): void;
```

Defined in: [loader/Phosphor.ts:196](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L196)

#### Returns

`void`

***

### updateIcon()

```ts
updateIcon(icon?): UIPhosphorIcon;
```

Defined in: [loader/Phosphor.ts:271](https://github.com/fest-live/icon.ts/blob/17b1c815b863bca7c041b37cdec15672902e03dc/src/loader/Phosphor.ts#L271)

#### Parameters

##### icon?

`string`

#### Returns

`UIPhosphorIcon`
