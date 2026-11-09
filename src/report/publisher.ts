/** 公開するファイル。path は公開先のリポジトリでのパス。 */
export interface PublishFile {
    readonly path: string;
    readonly content: Buffer;
}

/** デプロイが失敗した。コミットをやり直せば成功する見込みがある。 */
export class DeployFailedError extends Error {
    override name = 'DeployFailedError';
}

/**
 * HTML を公開する先。REPORT_PUBLISHER で実装を差し替える。
 * 取り込みと完了待ちを分けているのは、再起動しても完了待ちから続けられるようにするため。
 */
export interface Publisher {
    /** files を取り込み、完了待ちに使う識別子を返す。内容が同じでもデプロイはやり直す。 */
    commit(files: readonly PublishFile[], message: string): Promise<string>;
    /** デプロイの完了を待ち、paths の閲覧 URL を返す。 */
    urlsFor(
        ref: string,
        paths: readonly string[]
    ): Promise<ReadonlyMap<string, string>>;
}
