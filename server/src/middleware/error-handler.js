export function errorHandler(
    error,
    req,
    res,
    next
) {
    console.error(
        `[${new Date().toISOString()}]`,
        error
    );

    if (res.headersSent) {
        return next(error);
    }

    res.status(
        error.statusCode || 500
    ).json({
        success: false,

        message:
            error.publicMessage ||
            error.message ||
            'Internal server error.'
    });
}