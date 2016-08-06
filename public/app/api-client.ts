import { Http, Response, Headers, URLSearchParams } from '@angular/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs/Observable';
import { User } from './view-model';

@Injectable()
export class ApiClient {
    constructor(private http: Http) {
        console.log('api client created');
    }

    public checkUserExist(userId: string): Observable<any> {
        return this.httpGet('api/checkUserExist', {userId:userId});
    }

    public signIn(userId, password): Observable<any> {
        return this.httpPost('api/signIn', {userId:userId, password:password});
    }

    public signInByGuest(user:User) : Observable<any> {
        return this.httpPost('api/signInByGuest', {user:user});
    }

    public signUp(user:User): Observable<any> {
        return this.httpPost('api/signUp', {user:user});
    }

    public getQufoxUrl() : Observable<any> {
        return this.httpGet("api/qufox");
    }

    public refreshToken() : Observable<any> {
        return this.httpGet("api/refreshToken");
    }

    public getMyInfo() : Observable<any> {
        return this.httpGet("api/user");
    }

    public getRandomAvatarUrl() : Observable<any> {
        return this.httpGet('api/avatars/random');
    }

    private httpGet(url, paramObj:any = null): Observable<Response>{
        if (paramObj){
            let params = new URLSearchParams();
            for (var name in paramObj){
                params.set(name, paramObj[name]);
            }

            return this.http.get(url, {search:params})
            .map(this.extractData)
            .catch(this.handleError);
        }
        else {
            return this.http.get(url)
            .map(this.extractData)
            .catch(this.handleError);
        }
    }

    private httpPost(url, data): Observable<Response>{
        let headers = new Headers({'Content-Type': 'application/json'});
        return this.http.post(url, JSON.stringify(data), {headers: headers})
        .map(this.extractData)
        .catch(this.handleError);
    }

    private extractData(res: Response) {
        let body = res.json();
        if (body.err) throw {message:body.err};
        return body.result;
    }

    private handleError(error: any) {
        // In a real world app, we might use a remote logging infrastructure
        // We'd also dig deeper into the error to get a better message
        let errMsg = (error.message) ? error.message :
        error.status ? `${error.status} - ${error.statusText}` : 'Server error';
        console.error(errMsg); // log to console instead
        return Observable.throw(errMsg);
    }
}
