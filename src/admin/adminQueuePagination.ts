export function shouldResetAdminPage(page: number, cursorRequest: boolean, itemCount: number): boolean {
    return itemCount === 0 && (page > 1 || cursorRequest);
}
