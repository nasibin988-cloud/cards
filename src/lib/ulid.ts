import { ulid } from 'ulid';

export function id(): string {
  return ulid();
}
