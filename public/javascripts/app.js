'use strict';

/* App Module */

angular.module('bongtalkApp', [
	'ngRoute',
	'ngCookies',
	'ngAnimate',
	'ngDialog',
	'luegg.directives',
    'bongtalk.controllers',
    'bongtalk.filters'
])
.config(['$routeProvider',
	function ($routeProvider) {
		$routeProvider
			.when('/', { templateUrl: 'partials/boot.html', controller: 'BootController' })
			.when('/main', { templateUrl: 'partials/main.html', controller: 'MainController' })
			.when('/main/:left', { templateUrl: 'partials/main.html', controller: 'MainController' })
			.when('/main/:left/:right', { templateUrl: 'partials/main.html', controller: 'MainController' })
			.when('/main/:left/:right/:param', { templateUrl: 'partials/main.html', controller: 'MainController' })
			.when('/login', { templateUrl: 'partials/loginDialog.html', controller: 'LoginDialogController' })
			.when('/signout', { templateUrl: 'partials/boot.html', controller: 'SignOutController' })
			.when('/signin', { templateUrl: 'partials/signInDialog.html', controller: 'SignInDialogController' })
			.when('/signup', { templateUrl: 'partials/signUpDialog.html', controller: 'SignUpDialogController' })
			.when('/test', { templateUrl: 'partials/test.html', controller: 'TestController' })
			.otherwise({ redirectTo: '/'});
	}])
.run(['$window', '$rootScope', '$location', '$cookies', 'emitter', 'apiClient', 'viewmodel', 
    function ($window, $rootScope, $location, $cookies, emitter, apiClient, viewmodel) {
        $rootScope.vm = viewmodel;
        $rootScope.goBack = function () {
            $window.history.back();
        };
        $rootScope.checkLogin = function (callback) {
            var authToken = $cookies.getObject('auth_token');
            if (authToken) {
                if ($rootScope.vm.data && $rootScope.vm.data.user) {
                    callback($rootScope.vm.data.user);
                }
                else {
                    apiClient.getMyInfo(function (err, result) {
                        if (err) {
                            $location.path('/login');
                        }
                        else {
                            callback(result);
                        }
                    });
                }
            }
            else {
                $location.path('/login');
            }
        };
	}]);