// Thin NestJS adapter — reuses the SAME core Express/Fastify logic already
// built into eip-sdk's index.js (monitor.middleware(), monitor.captureException())
// rather than reimplementing request timing/trace-context extraction a
// second time.
//
// @nestjs/common and @nestjs/core are optional peer dependencies: never
// required by index.js itself, and only require()'d here, lazily, inside
// these factory functions — so Express/Fastify-only consumers of eip-sdk
// are never forced to install Nest.
//
// Usage:
//   const monitor = require('eip-sdk').init({ ... });
//   const { createEipModule, createEipExceptionFilter } = require('eip-sdk/nestjs');
//
//   @Module({ imports: [createEipModule(monitor)] })
//   export class AppModule {}
//
//   app.useGlobalFilters(new (createEipExceptionFilter(monitor))());

// Wires monitor.middleware() into Nest's own NestModule extension point —
// works under both platform-express and platform-fastify (Nest translates
// middleware via fastify-middie under the hood for the latter). Applying
// `Module({})` as a plain function call rather than a `@Module()` decorator
// means this needs no TS/Babel decorator-compilation step — this SDK ships
// plain CommonJS.
function createEipModule(monitor) {
  const { Module } = require('@nestjs/common');

  class EipModule {
    configure(consumer) {
      consumer.apply(monitor.middleware()).forRoutes('*');
    }
  }

  Module({})(EipModule);
  return EipModule;
}

// Necessary, not cosmetic: Nest's own exception zone intercepts controller/
// service errors *before* they ever reach Express-level error middleware, so
// monitor.errorHandler() alone never sees anything thrown from actual
// Nest-routed code (only errors from raw, non-Nest-routed Express
// middleware). This filter is the correct integration point for that case —
// it delegates to super.catch() so Nest's normal response formatting is
// completely unchanged; this filter only observes.
function createEipExceptionFilter(monitor) {
  const { BaseExceptionFilter } = require('@nestjs/core');

  class EipExceptionFilter extends BaseExceptionFilter {
    catch(exception, host) {
      try {
        const contextType = host.getType ? host.getType() : 'http';
        if (contextType === 'http') {
          const req = host.switchToHttp().getRequest();
          const err = exception instanceof Error ? exception : new Error(String(exception));
          monitor.captureException(err, {
            endpoint: req && (req.originalUrl || req.url),
            headers: req && req.headers,
            requestBody: req && req.body,
          });
        }
      } catch {
        // Telemetry capture must never break the app's own error handling.
      }
      return super.catch(exception, host);
    }
  }

  return EipExceptionFilter;
}

module.exports = { createEipModule, createEipExceptionFilter };
