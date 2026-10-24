/** A user as the API receives it. */
export interface User {
  /** @minimum 1 */
  id: number
  /** @format email */
  email: string
  /** @minLength 1 @maxLength 80 */
  name: string
  /** @minimum 13 @asType integer */
  age?: number
  role: 'admin' | 'user'
  /** @maxItems 3 */
  tags?: string[]
  address?: Address
}
export interface Address {
  street: string
  /** @pattern ^[0-9]{5}$ */
  zip: string
}
