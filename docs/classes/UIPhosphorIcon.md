[**@fest/icon v0.0.0**](../README.md)

***

[@fest/icon](../README.md) / UIPhosphorIcon

# Class: UIPhosphorIcon

Defined in: [loader/Phosphor.ts:47](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L47)

## Extends

- `HTMLElement`

## Constructors

### Constructor

```ts
new UIPhosphorIcon(options): UIPhosphorIcon;
```

Defined in: [loader/Phosphor.ts:69](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L69)

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

Defined in: [loader/Phosphor.ts:86](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L86)

##### Returns

`string`

#### Set Signature

```ts
set icon(value): void;
```

Defined in: [loader/Phosphor.ts:90](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L90)

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

Defined in: [loader/Phosphor.ts:101](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L101)

##### Returns

`string`

#### Set Signature

```ts
set iconStyle(value): void;
```

Defined in: [loader/Phosphor.ts:105](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L105)

##### Parameters

###### value

`string`

##### Returns

`void`

***

### size

#### Get Signature

```ts
get size(): null | string;
```

Defined in: [loader/Phosphor.ts:116](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L116)

##### Returns

`null` \| `string`

#### Set Signature

```ts
set size(value): void;
```

Defined in: [loader/Phosphor.ts:120](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L120)

##### Parameters

###### value

`null` | `string`

##### Returns

`void`

***

### width

#### Get Signature

```ts
get width(): null | string;
```

Defined in: [loader/Phosphor.ts:131](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L131)

##### Returns

`null` \| `string`

#### Set Signature

```ts
set width(value): void;
```

Defined in: [loader/Phosphor.ts:135](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L135)

##### Parameters

###### value

`null` | `string` | `number`

##### Returns

`void`

***

### observedAttributes

#### Get Signature

```ts
get static observedAttributes(): string[];
```

Defined in: [loader/Phosphor.ts:48](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L48)

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

Defined in: [loader/Phosphor.ts:177](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L177)

#### Parameters

##### name

`string`

##### oldValue

`null` | `string`

##### newValue

`null` | `string`

#### Returns

`void`

***

### connectedCallback()

```ts
connectedCallback(): void;
```

Defined in: [loader/Phosphor.ts:146](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L146)

#### Returns

`void`

***

### disconnectedCallback()

```ts
disconnectedCallback(): void;
```

Defined in: [loader/Phosphor.ts:171](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L171)

#### Returns

`void`

***

### updateIcon()

```ts
updateIcon(icon?): UIPhosphorIcon;
```

Defined in: [loader/Phosphor.ts:231](https://github.com/fest-live/icon.ts/blob/c6bcb338344f0328b5f9fc933623fd581bc608f4/src/loader/Phosphor.ts#L231)

#### Parameters

##### icon?

`string`

#### Returns

`UIPhosphorIcon`
