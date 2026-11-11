# Uses Ruby File.fnmatch flags matching GitLab rules:changes semantics.
# Run with: ruby scripts/test_ci_budget.rb
require 'yaml'

class CIBudgetTest
  def assert(value, message = 'assertion failed')
    raise message unless value
  end

  def assert_equal(expected, actual, message = '')
    assert(expected == actual, "#{message}: expected #{expected.inspect}, got #{actual.inspect}")
  end

  def assert_includes(value, part)
    assert(value.include?(part), "missing #{part}")
  end
  def setup
    @ci = YAML.load_file(File.expand_path('../.gitlab-ci.yml', __dir__), aliases: true)
  end

  def selected(path)
    %w[rust admin helm].select do |job|
      @ci.fetch(job).fetch('rules').last.fetch('changes').any? do |pattern|
        File.fnmatch(pattern, path, File::FNM_PATHNAME | File::FNM_DOTMATCH | File::FNM_EXTGLOB)
      end
    end
  end

  def test_path_matrix
    {
      'README.md' => [], 'docs/architecture.md' => [],
      'admin/src/App.tsx' => ['admin'], 'admin/package-lock.json' => ['admin'],
      'crates/sitegraph-api/src/main.rs' => ['rust'], 'Cargo.lock' => ['rust'],
      'rust-toolchain.toml' => ['rust'], '.cargo/config.toml' => ['rust'],
      'migrations/0030_example.sql' => ['rust'],
      'adapters/flintplate-contract/fixtures/menu-snapshot-v1.json' => ['rust'],
      'deploy/saas/helm/fireflint/templates/deployment.yaml' => ['helm'],
      'deploy/saas/values.example.yaml' => ['helm'],
      '.gitlab-ci.yml' => %w[rust admin helm]
    }.each { |path, jobs| assert_equal jobs, selected(path), path }
  end

  def test_drafts_and_auto_cancel
    assert_equal 'interruptible', @ci.dig('workflow', 'auto_cancel', 'on_new_commit')
    assert_equal true, @ci.dig('default', 'interruptible')
    %w[rust admin helm image-api image-admin].each do |name|
      guard = @ci.fetch(name).fetch('rules').first
      assert_includes guard.fetch('if'), 'CI_MERGE_REQUEST_DRAFT'
      assert_equal 'never', guard.fetch('when')
    end
    assert_equal [{'when' => 'on_success'}], @ci.dig('ci-status', 'rules')
  end

  def test_main_does_not_bypass_paths
    %w[rust admin helm].each do |name|
      assert_equal 2, @ci.fetch(name).fetch('rules').length
      assert @ci.fetch(name).fetch('rules').last.key?('changes')
    end
  end
end

test = CIBudgetTest.new
CIBudgetTest.instance_methods.grep(/^test_/).each do |method|
  test.setup
  test.public_send(method)
  puts "PASS #{method}"
end
