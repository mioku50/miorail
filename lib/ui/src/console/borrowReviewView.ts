// The borrow review is rendered identically by the server (for an assistant)
// and by both consoles (for a person), so it cannot live in a React package.
// It sits in the domain package beside the arithmetic it renders; this file
// keeps the console's single import surface intact.
export * from '@mioagent/rwa-issuer/borrowReview';
