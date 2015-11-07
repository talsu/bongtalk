module.exports = function(grunt) {

  // Project configuration.
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    concat : {
      libs_css: {
        src: [
          'bower_components/bootstrap/dist/css/bootstrap.css',
          'bower_components/ngDialog/css/ngDialog.css',
          'bower_components/ngDialog/css/ngDialog-theme-default.css',
          'bower_components/ngDialog/css/ngDialog-theme-plain.css',
          'public/stylesheets/gradient.css'
        ],
        dest: 'public/stylesheets/libs.css'
      },
      libs_js: {
        src: [
          'bower_components/jquery/dist/jquery.js',
          'bower_components/bootstrap/dist/js/bootstrap.js',
          'bower_components/angular/angular.js',
          'bower_components/angular-route/angular-route.js',
          'bower_components/angular-cookies/angular-cookies.js',
          'bower_components/angular-animate/angular-animate.js',
          'bower_components/angularjs-scroll-glue/src/scrollglue.js',
          'bower_components/ngDialog/js/ngDialog.js',
          'bower_components/jquery/dist/jquery.js',
          'bower_components/underscore/underscore.js',
          'bower_components/bootstrap/dist/js/bootstrap.js',
          'bower_components/eventEmitter/EventEmitter.js',
          'bower_components/async/dist/async.js',
          'bower_components/socket.io-client/socket.io.js',
          'bower_components/qufox-client/qufox-client.js',
          'public/javascripts/gradient.js'
        ],
        dest: 'public/javascripts/libs.js'
      }
    },
    uglify: {
      options: {

      },
      lib: {
        files:{
          'public/javascripts/libs.min.js':['public/javascripts/libs.js']
        }
      }
    },
    cssmin: {
      'public/stylesheets/libs.min.css':['public/stylesheets/libs.css']
    }

  });

  grunt.loadNpmTasks('grunt-contrib-concat');
  grunt.loadNpmTasks('grunt-contrib-uglify');
  grunt.loadNpmTasks('grunt-contrib-cssmin');

  grunt.registerTask('default', [ 'concat', 'uglify', 'cssmin' ]);

};
