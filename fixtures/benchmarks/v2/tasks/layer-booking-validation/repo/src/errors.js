// Errors shared by every layer. `code` is stable and meant for callers.
export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends AppError {
  constructor(field, message) {
    super('VALIDATION', message);
    this.field = field;
  }
}

export class NotFoundError extends AppError {
  constructor(what, id) {
    super('NOT_FOUND', what + ' not found: ' + id);
  }
}

export class ConflictError extends AppError {
  constructor(message) {
    super('CONFLICT', message);
  }
}
