# @percolator/api Test Suite

Comprehensive test suite for the Percolator API package.

## Quick Start

```bash
# Install dependencies
pnpm install

# Run tests
pnpm --filter @percolator/api test

# Watch mode
pnpm --filter @percolator/api test:watch
```

## Test Structure

```
tests/
├── middleware/
│   ├── auth.test.ts           # API key authentication
│   ├── rate-limit.test.ts     # Rate limiting (60 GET/min, 10 POST/min)
│   └── validateSlab.test.ts   # Solana public key validation
└── routes/
    ├── health.test.ts         # Health check endpoint
    ├── markets.test.ts        # Market data (on-chain + DB)
    ├── trades.test.ts         # Trade history & volume
    ├── funding.test.ts        # Funding rates
    ├── prices.test.ts         # Price data
    ├── insurance.test.ts      # Insurance fund
    ├── open-interest.test.ts  # Open interest
    ├── stats.test.ts          # Platform statistics
    └── crank.test.ts          # Crank status
```

## Test Count

- **Total**: 97 tests across 12 files
- **Middleware**: 23 tests
- **Routes**: 74 tests

## Coverage Areas

### Authentication & Security
- API key validation
- Rate limiting per IP
- Production vs dev mode

### Data Validation
- Solana public key format validation
- Query parameter bounds checking
- Error handling

### API Endpoints
- Health checks
- Market data (on-chain + database)
- Trading history
- Funding rates
- Insurance fund tracking
- Open interest monitoring
- Platform statistics
- Crank status

### Edge Cases
- Null/missing data
- Invalid inputs
- Database errors
- RPC failures
- Empty result sets
- Large numbers (BigInt handling)

## Writing New Tests

Example test structure:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { yourRouteFunction } from "../../src/routes/your-route.js";

// Mock dependencies
vi.mock("@percolator/shared", () => ({
  getSupabase: vi.fn(),
  getConnection: vi.fn(),
}));

describe("your route", () => {
  let mockSupabase: any;
  
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase = {
      from: vi.fn(() => mockSupabase),
      select: vi.fn(() => mockSupabase),
    };
    vi.mocked(getSupabase).mockReturnValue(mockSupabase);
  });

  it("should do something", async () => {
    mockSupabase.select.mockResolvedValue({ data: [], error: null });
    
    const app = yourRouteFunction();
    const res = await app.request("/your/endpoint");
    
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ expected: "result" });
  });
});
```

## Best Practices

1. **Mock all external dependencies** (database, RPC, core functions)
2. **Test both success and failure paths**
3. **Verify error messages and status codes**
4. **Test edge cases** (null, empty, invalid inputs)
5. **Use `beforeEach` to reset mocks** between tests
6. **Keep tests focused** - one concept per test
7. **Use descriptive test names** that explain what's being tested

## CI/CD Integration

Tests run automatically on:
- Pre-commit hooks
- Pull request checks
- CI/CD pipeline

All tests must pass before merging.

## Troubleshooting

### Mock not working?
- Ensure `vi.mock()` is at the top level (before imports)
- Use `vi.clearAllMocks()` in `beforeEach`

### Route not matching?
- Check route order (specific routes before parameterized)
- Verify path format exactly matches source

### Async issues?
- Always `await` async operations
- Use `mockResolvedValue` / `mockRejectedValue` for promises

## Related Documentation

- [TEST_SUMMARY.md](../TEST_SUMMARY.md) - Detailed test results
- [Vitest Docs](https://vitest.dev/)
- [Hono Testing Guide](https://hono.dev/docs/guides/testing)
