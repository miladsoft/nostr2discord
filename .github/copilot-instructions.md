# Nostr2Discord Bot - Development Guidelines

This project is a serverless application that forwards Nostr events to Discord via webhooks.

## Architecture

- Uses Netlify serverless functions to process webhook requests
- Implements a standalone webhook handler that can receive Nostr events or configuration updates
- Follows a stateless architecture appropriate for serverless environments

## Key Files

- `functions/webhook-simple.js`: Primary serverless function that handles webhook requests
- `netlify.toml`: Configuration for Netlify deployment
- `package.json`: Dependencies and build scripts
- `deploy.js`: Script to prepare files for deployment

## Development Workflow

1. Make changes to the files in the `functions/` directory
2. Test locally using `npm run dev` (runs Netlify dev server)
3. Run `npm test` to verify functionality
4. Deploy to Netlify

## Important Considerations for Netlify Deployment

- Netlify functions are stateless and have a maximum execution time of 10 seconds
- Memory used in one function invocation is not preserved for the next invocation
- Environment variables must be set in the Netlify dashboard
- The function handler must be exported as `exports.handler`

## Common Issues

1. **Missing Dependencies**: Make sure all required node modules are listed in the `external_node_modules` section of netlify.toml

2. **Environment Variables**: Ensure all required environment variables are set in the Netlify dashboard

3. **Function Timeouts**: Keep functions lightweight and avoid long-running operations

4. **Cold Starts**: First invocation may be slow as the function warms up

## Testing

- Use `npm test` to run the test script that validates the functions
- The `public/test.html` page provides a UI for manual testing after deployment