[**@fest-lib/icon v0.0.0**](../README.md)

***

[@fest-lib/icon](../README.md) / UIPhosphorIcon

# Class: UIPhosphorIcon

Defined in: [loader/Phosphor.ts:41](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L41)

## Extends

- `HTMLElement`

## Constructors

### Constructor

```ts
new UIPhosphorIcon(options): UIPhosphorIcon;
```

Defined in: [loader/Phosphor.ts:65](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L65)

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

Defined in: [loader/Phosphor.ts:82](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L82)

##### Returns

`string`

#### Set Signature

```ts
set icon(value): void;
```

Defined in: [loader/Phosphor.ts:86](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L86)

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

Defined in: [loader/Phosphor.ts:97](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L97)

##### Returns

`string`

#### Set Signature

```ts
set iconStyle(value): void;
```

Defined in: [loader/Phosphor.ts:101](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L101)

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

Defined in: [loader/Phosphor.ts:112](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L112)

##### Returns

`string` \| `null`

#### Set Signature

```ts
set size(value): void;
```

Defined in: [loader/Phosphor.ts:116](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L116)

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

Defined in: [loader/Phosphor.ts:127](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L127)

##### Returns

`string` \| `null`

#### Set Signature

```ts
set width(value): void;
```

Defined in: [loader/Phosphor.ts:131](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L131)

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

Defined in: [loader/Phosphor.ts:42](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L42)

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

Defined in: [loader/Phosphor.ts:176](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L176)

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

Defined in: [loader/Phosphor.ts:142](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L142)

#### Returns

`void`

***

### disconnectedCallback()

```ts
disconnectedCallback(): void;
```

Defined in: [loader/Phosphor.ts:168](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L168)

#### Returns

`void`

***

### updateIcon()

```ts
updateIcon(icon?): UIPhosphorIcon;
```

Defined in: [loader/Phosphor.ts:234](https://github.com/fest-live/icon.ts/blob/6b8b46a5655315a9f9ab4b934f887054c7eaf172/src/loader/Phosphor.ts#L234)

#### Parameters

##### icon?

`string`

#### Returns

`UIPhosphorIcon`
